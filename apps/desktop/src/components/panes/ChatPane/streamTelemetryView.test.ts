import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_STALL_THRESHOLD_MS,
  formatGap,
  groupStreamTelemetry,
  parseClockMs,
  shortId,
} from "./streamTelemetryView.js";
import type { StreamTelemetryEntry } from "./types.js";

let seq = 0;
function entry(
  at: string,
  action: string,
  eventType: string,
  overrides: Partial<StreamTelemetryEntry> = {},
): StreamTelemetryEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    at,
    streamId: "46111d93-8cb0-4ffd-9d4e-b94c3e99a36c",
    transportType: "event",
    eventName: eventType,
    eventType,
    inputId: "be1ecf8d-6b6d-4f0f-a0ac-2335c722f7f9",
    sessionId: "d61801dd-bf58-4f61-8ab3-a44d455ff796",
    action,
    detail: "",
    ...overrides,
  };
}

test("clock stamps parse, and anything unexpected degrades to null", () => {
  assert.equal(parseClockMs("17:26:12.585"), 62_772_585);
  assert.equal(parseClockMs("00:00:00.000"), 0);
  // Short fractions are padded, not misread as smaller numbers.
  assert.equal(parseClockMs("00:00:01.5"), 1_500);
  // A malformed stamp must not produce NaN arithmetic downstream.
  assert.equal(parseClockMs("nope"), null);
  assert.equal(parseClockMs(""), null);
});

test("gaps read in the unit that matters at that scale", () => {
  assert.equal(formatGap(null), "");
  assert.equal(formatGap(0), "+0ms");
  assert.equal(formatGap(999), "+999ms");
  assert.equal(formatGap(2_081), "+2.08s");
});

test("ids shorten to a correlatable prefix", () => {
  assert.equal(shortId("be1ecf8d-6b6d-4f0f"), "be1ecf8d");
  assert.equal(shortId("short"), "short");
  assert.equal(shortId("  "), "-");
});

test("received folds into its outcome, keeping the outcome", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:10.156", "received", "thinking_delta"),
    entry("17:26:10.156", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=7",
    }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].rows.length, 1, "the pair is one event, not two");
  assert.equal(turns[0].rows[0].outcome, "applied");
  assert.equal(turns[0].rows[0].chars, 7);
});

test("a run of deltas collapses to a count and a character total", () => {
  // Individually these say nothing; dozens of them hide everything structural.
  const turns = groupStreamTelemetry([
    entry("17:26:10.156", "received", "thinking_delta"),
    entry("17:26:10.156", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=7",
    }),
    entry("17:26:10.163", "received", "thinking_delta"),
    entry("17:26:10.163", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=4",
    }),
    entry("17:26:10.172", "received", "thinking_delta"),
    entry("17:26:10.172", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=2",
    }),
  ]);
  const [row] = turns[0].rows;
  assert.equal(turns[0].rows.length, 1);
  assert.equal(row.count, 3);
  assert.equal(row.chars, 13);
});

test("a different event ends the run", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:10.156", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=7",
    }),
    entry("17:26:10.200", "applied_output_delta", "output_delta", {
      detail: "delta_len=8",
    }),
  ]);
  assert.deepEqual(
    turns[0].rows.map((row) => [row.label, row.count]),
    [
      ["thinking_delta", 1],
      ["output_delta", 1],
    ],
  );
});

test("the 2s stall that started all of this is flagged and measured", () => {
  // Straight from a real trace: run_completed was received at 10.445 and not
  // applied until 12.526. In the flat view that was two unremarkable lines.
  const turns = groupStreamTelemetry([
    entry("17:26:10.366", "applied_output_delta", "output_delta", {
      detail: "delta_len=10",
    }),
    entry("17:26:10.445", "received", "run_completed"),
    entry("17:26:12.526", "applied_run_completed", "run_completed", {
      detail: "run completed",
    }),
  ]);
  const [turn] = turns;
  const stalled = turn.rows.filter((row) => row.stalled);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].label, "run_completed");
  // The gap is the time to APPLY, not the time to arrive — the event showed up
  // 79ms after the last delta and then the handler blocked.
  assert.equal(stalled[0].deltaMs, 79);
  assert.equal(stalled[0].applyLagMs, 2_081);
  assert.equal(formatGap(stalled[0].applyLagMs), "+2.08s");
  assert.equal(turn.stalls, 1);
  assert.equal(turn.worstGapMs, 2_081);
});

test("ordinary streaming does not trip the stall flag", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:10.156", "applied_output_delta", "output_delta"),
    entry("17:26:10.163", "applied_thinking_delta", "thinking_delta"),
  ]);
  assert.ok(7 < DEFAULT_STALL_THRESHOLD_MS);
  assert.equal(turns[0].rows.every((row) => !row.stalled), true);
});

test("a dropped frame keeps its reason instead of vanishing into the noise", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:12.560", "received", "done", {
      transportType: "done",
      inputId: "",
      detail: "active=- pending=-",
    }),
    entry("17:26:12.560", "drop_done_unmatched_stream", "done", {
      transportType: "done",
      inputId: "",
      detail: "active=- pending=-",
    }),
  ]);
  const row = turns[0].rows[turns[0].rows.length - 1];
  assert.match(row?.outcome ?? "", /^DROPPED/);
  assert.match(row?.outcome ?? "", /unmatched_stream/);
});

test("entries without an input id attach to the turn in progress", () => {
  // The `done` frame carries no input id. Bucketing it separately is what made
  // its fate hard to see next to the run_completed it raced.
  const turns = groupStreamTelemetry([
    entry("17:26:10.445", "received", "run_completed"),
    entry("17:26:12.526", "applied_run_completed", "run_completed"),
    entry("17:26:12.560", "drop_done_unmatched_stream", "done", {
      transportType: "done",
      inputId: "",
    }),
  ]);
  assert.equal(turns.length, 1, "one turn, not a turn plus an orphan");
  assert.equal(turns[0].rows[turns[0].rows.length - 1]?.label, "done");
});

test("turns come back newest-first with rows in forward order", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:01.000", "applied_run_started", "run_started", {
      inputId: "input-one",
    }),
    entry("17:26:02.000", "applied_run_completed", "run_completed", {
      inputId: "input-one",
    }),
    entry("17:26:05.000", "applied_run_started", "run_started", {
      inputId: "input-two",
    }),
    entry("17:26:06.000", "applied_run_completed", "run_completed", {
      inputId: "input-two",
    }),
  ]);
  assert.deepEqual(
    turns.map((turn) => turn.inputId),
    ["input-two", "input-one"],
    "the turn you just ran is the one you want to read",
  );
  assert.deepEqual(
    turns[0].rows.map((row) => row.label),
    ["run_started", "run_completed"],
    "but a turn only makes sense read forwards",
  );
  assert.equal(turns[0].durationMs, 1_000);
});

test("main-process rows stay distinguishable from renderer rows", () => {
  // Two vantage points on one stream. Folding them together invents causality —
  // which is exactly the mistake the flat view encouraged.
  const turns = groupStreamTelemetry([
    entry("17:26:12.585", "applied_run_completed", "run_completed"),
    entry("17:26:12.585", "main_emit_event", "emit_event", {
      transportType: "main",
      inputId: "",
      detail: "event=run_completed",
    }),
  ]);
  assert.deepEqual(
    turns[0].rows.map((row) => row.origin),
    ["renderer", "main"],
  );
});

test("an empty ring produces no turns", () => {
  assert.deepEqual(groupStreamTelemetry([]), []);
});

test("a collapsed run reports its WORST apply lag, not the first", () => {
  // One slow handler inside a burst of thirty is the signal. First-wins buries it.
  const turns = groupStreamTelemetry([
    entry("17:26:10.100", "received", "output_delta"),
    entry("17:26:10.105", "applied_output_delta", "output_delta", {
      detail: "delta_len=4",
    }),
    entry("17:26:10.110", "received", "output_delta"),
    entry("17:26:10.900", "applied_output_delta", "output_delta", {
      detail: "delta_len=6",
    }),
  ]);
  const [row] = turns[0].rows;
  assert.equal(row.count, 2);
  assert.equal(row.chars, 10);
  assert.equal(row.applyLagMs, 790, "the 790ms handler, not the 5ms one");
  assert.equal(row.stalled, true);
});

test("a collapsed run drops the first entry's detail once characters are summed", () => {
  // Printing "delta_len=7" beside "75 chars" asserts something untrue.
  const turns = groupStreamTelemetry([
    entry("17:26:10.100", "applied_output_delta", "output_delta", {
      detail: "delta_len=7",
    }),
    entry("17:26:10.110", "applied_output_delta", "output_delta", {
      detail: "delta_len=68",
    }),
  ]);
  const [row] = turns[0].rows;
  assert.equal(row.chars, 75);
  assert.equal(row.detail, "", "the stale per-entry detail is suppressed");
});

test("a single row keeps its detail", () => {
  const turns = groupStreamTelemetry([
    entry("17:26:10.100", "applied_run_completed", "run_completed", {
      detail: "run completed",
    }),
  ]);
  assert.equal(turns[0].rows[0].detail, "run completed");
});

test("the latency summary answers where the time went, from a real trace", () => {
  // Jeffrey's turn f17504ed. 136 rows in the flat view; the answer is two
  // upstream stalls neither of which is the renderer.
  const turns = groupStreamTelemetry([
    entry("17:42:38.700", "submit", "submit", {
      transportType: "user",
      inputId: "",
      detail: "chars=12",
    }),
    entry("17:42:38.724", "main_open_requested", "open_requested", {
      transportType: "main",
      inputId: "",
    }),
    entry("17:42:38.796", "main_http_response", "http_response", {
      transportType: "main",
      inputId: "",
      detail: "status=200 message=OK",
    }),
    entry("17:42:39.960", "received", "run_claimed"),
    entry("17:42:43.370", "received", "run_started"),
    entry("17:42:46.940", "applied_thinking_delta", "thinking_delta", {
      detail: "delta_len=7",
    }),
  ]);
  const { latency } = turns[0];

  assert.equal(latency.startsAtStreamOpen, false, "measured from the keypress");
  assert.equal(latency.toFirstTokenMs, 8_240);
  assert.equal(latency.firstTokenKind, "thinking");

  assert.deepEqual(
    latency.phases.map((phase) => [phase.label, phase.durationMs]),
    [
      ["queue input", 24],
      ["connect", 72],
      ["claim run", 1_164],
      ["start harness", 3_410],
      ["first token", 3_570],
    ],
  );
  // The dominant phase is what you act on.
  const dominant = latency.phases.filter((phase) => phase.dominant);
  assert.equal(dominant.length, 1);
  assert.equal(dominant[0].label, "first token");
  assert.match(dominant[0].blames, /model/);
  // Shares are fractions of the measured window.
  assert.ok(Math.abs(dominant[0].share - 3_570 / 8_240) < 0.001);
});

test("a replayed stream cannot rewrite the timeline", () => {
  // The duplicate stream open re-emits run_claimed from sequence 1. Taking the
  // later timestamp would silently move the milestone and understate the wait.
  const turns = groupStreamTelemetry([
    entry("17:42:38.700", "submit", "submit", {
      transportType: "user",
      inputId: "",
    }),
    entry("17:42:39.000", "received", "run_claimed"),
    entry("17:42:39.500", "applied_output_delta", "output_delta"),
    entry("17:42:47.000", "drop_unmatched_event", "run_claimed", {
      detail: "replayed",
    }),
  ]);
  assert.equal(turns[0].latency.toFirstTokenMs, 800);
  assert.equal(turns[0].latency.firstTokenKind, "output");
});

test("without a submit milestone the window is honestly marked as a floor", () => {
  const turns = groupStreamTelemetry([
    entry("17:42:38.724", "main_open_requested", "open_requested", {
      transportType: "main",
      inputId: "",
    }),
    entry("17:42:39.000", "applied_thinking_delta", "thinking_delta"),
  ]);
  assert.equal(turns[0].latency.startsAtStreamOpen, true);
  assert.equal(turns[0].latency.toFirstTokenMs, 276);
});

test("a turn with no token yet reports no first-token time", () => {
  const turns = groupStreamTelemetry([
    entry("17:42:38.700", "submit", "submit", {
      transportType: "user",
      inputId: "",
    }),
    entry("17:42:39.000", "received", "run_claimed"),
  ]);
  assert.equal(turns[0].latency.toFirstTokenMs, null);
  assert.deepEqual(turns[0].latency.phases, []);
});
