import assert from "node:assert/strict";
import { test } from "node:test";

import { runPiInProcess } from "./in-process.js";

/**
 * These guard the things the SUBPROCESS was providing for free. Each of them
 * fails silently rather than loudly if the in-process path gets it wrong, which
 * is exactly why they are pinned here rather than left to review.
 */

type PiEmit = (
  request: unknown,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
) => void;

const REQUEST = { session_id: "sess-1", input_id: "input-1" };

/** Stub pi through the injection seam, so these exercise the adapter's
 *  bookkeeping — where every blocker lives — without a real model turn. */
function withPi(
  runPiImpl: (request: unknown, deps: { emitEvent?: PiEmit }) => Promise<number>,
) {
  return {
    runPi: runPiImpl as never,
    defaultPiDeps: (() => ({ createSession: async () => ({}) })) as never,
  };
}

test("terminal accounting is computed from the events actually emitted", async () => {
  // The debug CLI's adapter hardcodes sawEvent/terminalEmitted to true. Copying
  // that would make every non-terminating run (OOM, unhandled rejection in a
  // tool, native abort) report clean — the caller sees no terminal event and
  // hangs to its 30-minute timeout instead of failing in seconds.
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_started", {});
    deps.emitEvent?.(request, 2, "output_delta", { text: "hi" });
    return 0;
  });

  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
  });

  assert.equal(result.sawEvent, true);
  assert.equal(result.lastSequence, 2);
  assert.equal(
    result.terminalEmitted,
    false,
    "no run_completed was emitted, so this must NOT claim a terminal event",
  );
});

test("a terminal event sets terminalEmitted", async () => {
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_completed", {});
    return 0;
  });
  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
  });
  assert.equal(result.terminalEmitted, true);
});

test("a throw BEFORE the terminal event is a failed run", async () => {
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_started", {});
    throw new Error("model exploded");
  });
  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
  });
  assert.equal(result.terminalEmitted, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /model exploded/);
  assert.equal(result.postTerminalError, null);
});

test("a throw AFTER the terminal event must not look like a failed run", async () => {
  // pi emits run_completed and THEN runs compaction and dispose in its finally.
  // In-process, a throw from either propagates here. Reporting it as a failure
  // makes the caller relay run_failed, which clears the persisted
  // harness_session_id — the user loses their conversation after a turn that
  // actually succeeded.
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_completed", {});
    throw new Error("compaction failed");
  });
  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
  });

  assert.equal(result.terminalEmitted, true, "the turn DID complete");
  assert.equal(result.exitCode, 0, "and must not be reported as a failure");
  assert.equal(result.postTerminalError, "compaction failed");
  assert.doesNotMatch(result.stderr, /compaction failed/);
});

test("events relay in order, and the run waits for the relay to drain", async () => {
  // PiDeps.emitEvent is synchronous and does not await, but the caller's relay
  // persists the harness session id. Fire-and-forget would let a later event
  // overtake an earlier one and let this return before persistence finished.
  const relayed: number[] = [];
  const deps = withPi(async (request, deps) => {
    for (let i = 1; i <= 5; i += 1) {
      deps.emitEvent?.(request, i, "output_delta", {});
    }
    deps.emitEvent?.(request, 6, "run_completed", {});
    return 0;
  });

  await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async (event) => {
      // Earlier events sleep LONGER: fire-and-forget would reorder these.
      await new Promise((r) => setTimeout(r, 12 - event.sequence));
      relayed.push(event.sequence);
    },
  });

  assert.deepEqual(
    relayed,
    [1, 2, 3, 4, 5, 6],
    "emission order must survive the relay",
  );
});

test("a relay failure is reported without poisoning later events", async () => {
  const relayed: number[] = [];
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "output_delta", {});
    deps.emitEvent?.(request, 2, "output_delta", {});
    deps.emitEvent?.(request, 3, "run_completed", {});
    return 0;
  });

  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async (event) => {
      if (event.sequence === 1) {
        throw new Error("relay boom");
      }
      relayed.push(event.sequence);
    },
  });

  assert.deepEqual(relayed, [2, 3], "one bad relay must not drop the rest");
  assert.match(result.stderr, /relay boom/);
  assert.equal(
    result.terminalEmitted,
    true,
    "bookkeeping reflects what pi emitted, not what the relay delivered",
  );
});

test("a run that emits nothing trips the first-event watchdog", async () => {
  // The subprocess got this from being killable. In-process there is no child,
  // so a bootstrap step that blocks forever (an MCP transport that never opens)
  // would otherwise run to the caller's 30-minute timeout.
  const deps = withPi(async () => {
    await new Promise((r) => setTimeout(r, 80));
    return 0;
  });

  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
    firstEventTimeoutMs: 20,
  });

  assert.equal(result.sawEvent, false);
  assert.match(result.stderr, /no events within 20ms/);
});

test("the watchdog does not fire once an event has arrived", async () => {
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_started", {});
    await new Promise((r) => setTimeout(r, 60));
    deps.emitEvent?.(request, 2, "run_completed", {});
    return 0;
  });

  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
    firstEventTimeoutMs: 25,
  });

  assert.equal(result.sawEvent, true);
  assert.equal(result.stderr, "", "a slow-but-alive run is not a timeout");
});

test("first-event and first-token timings are reported for the TTFT line", async () => {
  const deps = withPi(async (request, deps) => {
    deps.emitEvent?.(request, 1, "run_started", {});
    await new Promise((r) => setTimeout(r, 30));
    deps.emitEvent?.(request, 2, "thinking_delta", {});
    return 0;
  });

  const result = await runPiInProcess({
    requestPayload: REQUEST,
    deps,
    emitEvent: async () => {},
  });

  assert.ok(typeof result.harnessSpawnToFirstEventMs === "number");
  assert.ok(typeof result.harnessSpawnToFirstTokenMs === "number");
  assert.ok(
    (result.harnessSpawnToFirstTokenMs ?? 0) >=
      (result.harnessSpawnToFirstEventMs ?? 0),
    "first token cannot precede first event",
  );
});
