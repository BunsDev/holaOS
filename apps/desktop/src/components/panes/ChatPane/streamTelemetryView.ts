import type { StreamTelemetryEntry } from "./types";

/**
 * Turns the flat stream-telemetry ring into something you can actually read:
 * one group per turn, in chronological order, with the time BETWEEN events
 * rather than only absolute clock stamps.
 *
 * The flat view had three problems, all of which cost real debugging time:
 *
 *  - Finding a stall meant subtracting timestamps by hand. A 2s gap between
 *    `received run_completed` and `applied_run_completed` was sitting in plain
 *    sight and read as just two more lines.
 *  - Every event logged twice (`received` then `applied_*`), so half the rows
 *    carried no information beyond "it was not dropped".
 *  - Runs of `thinking_delta` / `output_delta` — dozens per turn, often 1-4
 *    characters each — buried everything structural.
 *
 * So: deltas collapse into one row with a count and a character total, the
 * received/applied pair collapses into one row that keeps the OUTCOME, and any
 * gap past the stall threshold is flagged. What is left is the shape of a turn.
 */

/** A gap longer than this is worth looking at. Well above the frame budget and
 *  above normal provider chunk spacing (~10ms in practice), so it flags stalls
 *  without flagging ordinary streaming. */
export const DEFAULT_STALL_THRESHOLD_MS = 400;

export interface TelemetryRow {
  key: string;
  /** Clock time of the first entry folded into this row. */
  at: string;
  /** Since the previous row in this turn; null for the first row. */
  deltaMs: number | null;
  /**
   * `received` -> applied/dropped, for a folded pair.
   *
   * Kept SEPARATE from deltaMs because they are different failures wearing the
   * same clothes: a long deltaMs is the event taking a while to arrive
   * (upstream), while a long applyLagMs is the event arriving promptly and the
   * renderer taking that long to handle it (a blocked main thread). Folding
   * them into one number is what hid a 2s handler stall as an unremarkable
   * 79ms row.
   */
  applyLagMs: number | null;
  /** Either gap exceeded the stall threshold — the thing you are usually hunting. */
  stalled: boolean;
  label: string;
  /** How many entries folded together (1 unless a delta run collapsed). */
  count: number;
  /** Summed `delta_len=` across a collapsed run, when present. */
  chars: number | null;
  /** "applied", or the drop reason — what actually became of the event. */
  outcome: string;
  detail: string;
  /** `main` rows come from the main process's SSE relay, `renderer` from the
   *  event subscription. Kept distinct because they are different vantage
   *  points on the same stream and conflating them invents causality. */
  origin: "renderer" | "main";
}

export interface TelemetryTurn {
  /** Input id, or "" for entries that never carried one. */
  inputId: string;
  shortInputId: string;
  startedAt: string;
  /** First to last entry in this turn. */
  durationMs: number | null;
  rows: TelemetryRow[];
  /** Where the time went from submit to first painted token. */
  latency: TurnLatency;
  stalls: number;
  /** Longest single gap, so a turn's worst stall shows in the header. */
  worstGapMs: number;
}

/** "HH:MM:SS.mmm" -> ms since midnight. Returns null for anything unexpected so
 *  a malformed stamp degrades to "no delta" instead of NaN arithmetic. */
export function parseClockMs(at: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(at.trim());
  if (!match) {
    return null;
  }
  const [, hh, mm, ss, ms] = match;
  return (
    Number(hh) * 3_600_000 +
    Number(mm) * 60_000 +
    Number(ss) * 1_000 +
    Number(ms.padEnd(3, "0"))
  );
}

/** Human-readable gap. Sub-second in ms (that is the resolution that matters
 *  for jank), seconds above that. */
export function formatGap(deltaMs: number | null): string {
  if (deltaMs === null) {
    return "";
  }
  if (deltaMs < 1_000) {
    return `+${deltaMs}ms`;
  }
  return `+${(deltaMs / 1_000).toFixed(2)}s`;
}

export function shortId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "-";
  }
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

function deltaLenFromDetail(detail: string): number | null {
  const match = /delta_len=(\d+)/.exec(detail);
  return match ? Number(match[1]) : null;
}

/** The event this entry is about, preferring the specific type. */
function labelFor(entry: StreamTelemetryEntry): string {
  return (entry.eventType || entry.eventName || entry.action).trim();
}

function isReceived(entry: StreamTelemetryEntry): boolean {
  return entry.action === "received";
}

function outcomeFor(entry: StreamTelemetryEntry): string {
  if (entry.action.startsWith("applied_") || entry.action === "applied") {
    return "applied";
  }
  if (entry.action.startsWith("drop_")) {
    // The reason matters more than the prefix: "unmatched_stream" is the useful
    // half of "drop_done_unmatched_stream".
    return `DROPPED ${entry.action.replace(/^drop_[a-z]*_?/, "") || "—"}`;
  }
  if (entry.action.startsWith("main_")) {
    return "";
  }
  return entry.action;
}

/**
 * Group into turns.
 *
 * `entries` is oldest-first (the ring's own order). Turns come back
 * newest-first, because that is what you want to look at after a turn ends,
 * while ROWS stay oldest-first, because a turn only makes sense read forwards.
 *
 * Entries with no input id are attached to the turn in progress rather than
 * bucketed separately: `done` frames and early `received` rows genuinely belong
 * to the turn that was running, and splitting them out is what made the `done`
 * frame's fate hard to see in the first place.
 */
export function groupStreamTelemetry(
  entries: readonly StreamTelemetryEntry[],
  options?: { stallThresholdMs?: number },
): TelemetryTurn[] {
  const stallThresholdMs =
    options?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

  // Bucket first, preserving order, so a turn's rows keep their real sequence.
  const order: string[] = [];
  const buckets = new Map<string, StreamTelemetryEntry[]>();
  let currentInputId = "";
  // Entries seen before any input id appears. These are the MOST important ones
  // for latency — submit, stream open, the HTTP round trip all happen before an
  // input_id exists — so they attach FORWARD to the turn they precede. Bucketing
  // them backwards is what produced a stray "turn -" holding the very
  // milestones the timeline starts from.
  let leadingOrphans: StreamTelemetryEntry[] = [];
  for (const entry of entries) {
    const inputId = entry.inputId.trim();
    if (!inputId && !currentInputId) {
      leadingOrphans.push(entry);
      continue;
    }
    if (inputId) {
      currentInputId = inputId;
    }
    const key = inputId || currentInputId;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
      if (leadingOrphans.length > 0) {
        buckets.get(key)?.push(...leadingOrphans);
        leadingOrphans = [];
      }
    }
    buckets.get(key)?.push(entry);
  }
  // Never attributed to a turn (a stream that produced nothing). Kept rather
  // than dropped — a turn that dies before its first event is worth seeing.
  if (leadingOrphans.length > 0) {
    buckets.set("", leadingOrphans);
    order.push("");
  }

  const turns: TelemetryTurn[] = [];
  for (const key of order) {
    const bucket = buckets.get(key) ?? [];
    if (bucket.length === 0) {
      continue;
    }
    const rows = collapseRows(bucket, stallThresholdMs);
    const firstMs = parseClockMs(bucket[0].at);
    const lastMs = parseClockMs(bucket[bucket.length - 1].at);
    turns.push({
      inputId: key,
      shortInputId: shortId(key),
      startedAt: bucket[0].at,
      durationMs:
        firstMs !== null && lastMs !== null ? Math.max(0, lastMs - firstMs) : null,
      rows,
      latency: summarizeTurnLatency(bucket),
      stalls: rows.filter((row) => row.stalled).length,
      worstGapMs: rows.reduce(
        (worst, row) =>
          Math.max(worst, row.deltaMs ?? 0, row.applyLagMs ?? 0),
        0,
      ),
    });
  }
  return turns.reverse();
}

function collapseRows(
  bucket: readonly StreamTelemetryEntry[],
  stallThresholdMs: number,
): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  let previousMs: number | null = null;

  for (let index = 0; index < bucket.length; index += 1) {
    const entry = bucket[index];
    const label = labelFor(entry);
    const origin: "renderer" | "main" =
      entry.transportType === "main" ? "main" : "renderer";

    // Fold `received` into the following applied/drop for the same event: on its
    // own it only says "arrived", and the pair is what tells you the outcome.
    let outcomeEntry = entry;
    let applyLagMs: number | null = null;
    if (isReceived(entry)) {
      const next = bucket[index + 1];
      if (next && !isReceived(next) && labelFor(next) === label) {
        outcomeEntry = next;
        const receivedMs = parseClockMs(entry.at);
        const appliedMs = parseClockMs(next.at);
        if (receivedMs !== null && appliedMs !== null) {
          applyLagMs = Math.max(0, appliedMs - receivedMs);
        }
        index += 1;
      }
    }

    let count = 1;
    let chars = deltaLenFromDetail(outcomeEntry.detail);
    // Collapse a run of the same event. Deltas arrive in dozens per turn and
    // individually say nothing; the count and total characters do.
    while (index + 1 < bucket.length) {
      const candidate = bucket[index + 1];
      if (labelFor(candidate) !== label) {
        break;
      }
      const candidateOrigin =
        candidate.transportType === "main" ? "main" : "renderer";
      if (candidateOrigin !== origin) {
        break;
      }
      if (isReceived(candidate)) {
        const after = bucket[index + 2];
        if (after && !isReceived(after) && labelFor(after) === label) {
          const len = deltaLenFromDetail(after.detail);
          if (len !== null) {
            chars = (chars ?? 0) + len;
          }
          // The WORST apply lag in the run, not the first: one slow handler in a
          // burst of thirty is the signal, and averaging or first-wins buries it.
          const candidateReceivedMs = parseClockMs(candidate.at);
          const candidateAppliedMs = parseClockMs(after.at);
          if (candidateReceivedMs !== null && candidateAppliedMs !== null) {
            const lag = Math.max(0, candidateAppliedMs - candidateReceivedMs);
            applyLagMs = Math.max(applyLagMs ?? 0, lag);
          }
          count += 1;
          index += 2;
          continue;
        }
      }
      const len = deltaLenFromDetail(candidate.detail);
      if (len !== null) {
        chars = (chars ?? 0) + len;
      }
      count += 1;
      index += 1;
    }

    const atMs = parseClockMs(entry.at);
    const deltaMs =
      atMs !== null && previousMs !== null ? Math.max(0, atMs - previousMs) : null;
    if (atMs !== null) {
      previousMs = atMs;
    }

    rows.push({
      key: entry.id,
      at: entry.at,
      deltaMs,
      applyLagMs,
      stalled:
        (deltaMs !== null && deltaMs >= stallThresholdMs) ||
        (applyLagMs !== null && applyLagMs >= stallThresholdMs),
      label: label || "(unnamed)",
      count,
      chars,
      outcome: outcomeFor(outcomeEntry),
      // Suppressed for a collapsed run whose characters are already summed: the
      // surviving detail belongs to the first entry only, so printing
      // "delta_len=7" next to "75 chars" asserts something untrue.
      detail: count > 1 && chars !== null ? "" : outcomeEntry.detail,
      origin,
    });
  }

  return rows;
}

/**
 * Where the time went between pressing send and seeing something.
 *
 * This is the question the row list could not answer. 136 rows of
 * `+0ms main·emit_event` say nothing about why a turn felt slow; five labelled
 * phases with durations say it immediately. The phases are chosen so each one
 * blames a different component — that is the whole point of splitting them:
 *
 *   submit -> open        the renderer queueing the input and getting an id back
 *   open -> connected     HTTP round trip to the local runtime
 *   connected -> claimed  the runtime picking the run off its queue
 *   claimed -> started    harness startup (process spawn, MCP, context build)
 *   started -> 1st token  the model's own latency before it emits anything
 *
 * A slow phase points at exactly one place, so nobody has to guess whether a
 * seven-second wait was the model, the queue, or our own rendering.
 */
export interface LatencyPhase {
  label: string;
  /** What to look at if this phase is the slow one. */
  blames: string;
  durationMs: number;
  /** Fraction of the measured window, for the bar. */
  share: number;
  dominant: boolean;
}

export interface TurnLatency {
  /** Submit (or the earliest milestone present) to the first painted token. */
  toFirstTokenMs: number | null;
  /** Whether the first thing on screen was reasoning or answer text. */
  firstTokenKind: "thinking" | "output" | null;
  /** True when the window starts at the stream open because no submit was
   *  recorded — the number is then a floor, not the full wait. */
  startsAtStreamOpen: boolean;
  phases: LatencyPhase[];
}

/** Milestones in the order they must occur, each with the label for the phase
 *  that ENDS at it and who to blame for that phase being slow. */
const MILESTONES: Array<{
  key: string;
  label: string;
  blames: string;
  match: (entry: StreamTelemetryEntry) => boolean;
}> = [
  {
    key: "submit",
    label: "submit",
    blames: "",
    match: (e) => e.action === "submit",
  },
  {
    key: "open",
    label: "queue input",
    blames: "renderer + runtime queue write",
    match: (e) => e.action === "main_open_requested",
  },
  {
    key: "connected",
    label: "connect",
    blames: "local HTTP round trip",
    match: (e) => e.action === "main_http_response",
  },
  {
    key: "claimed",
    label: "claim run",
    blames: "runtime queue poller",
    match: (e) => e.eventType === "run_claimed",
  },
  {
    key: "started",
    label: "start harness",
    blames: "harness startup: spawn, MCP, context build",
    match: (e) => e.eventType === "run_started",
  },
  {
    key: "first_token",
    label: "first token",
    blames: "model time-to-first-token",
    match: (e) =>
      (e.eventType === "thinking_delta" || e.eventType === "output_delta") &&
      (e.action.startsWith("applied_") || e.action === "received"),
  },
];

export function summarizeTurnLatency(
  entries: readonly StreamTelemetryEntry[],
): TurnLatency {
  const found = new Map<string, number>();
  let firstTokenKind: "thinking" | "output" | null = null;
  for (const entry of entries) {
    const ms = parseClockMs(entry.at);
    if (ms === null) {
      continue;
    }
    for (const milestone of MILESTONES) {
      // First occurrence only: a replayed stream re-emits run_claimed and would
      // otherwise rewrite the timeline with a later, meaningless timestamp.
      if (!found.has(milestone.key) && milestone.match(entry)) {
        found.set(milestone.key, ms);
        if (milestone.key === "first_token") {
          firstTokenKind =
            entry.eventType === "thinking_delta" ? "thinking" : "output";
        }
      }
    }
  }

  const firstTokenMs = found.get("first_token") ?? null;
  const startKey = found.has("submit") ? "submit" : "open";
  const startMs = found.get(startKey) ?? null;

  const phases: LatencyPhase[] = [];
  if (startMs !== null && firstTokenMs !== null && firstTokenMs >= startMs) {
    const total = Math.max(1, firstTokenMs - startMs);
    let previousMs = startMs;
    let previousIndex = MILESTONES.findIndex((m) => m.key === startKey);
    for (let i = previousIndex + 1; i < MILESTONES.length; i += 1) {
      const milestone = MILESTONES[i];
      const at = found.get(milestone.key);
      if (at === undefined) {
        continue; // Milestone absent — its phase folds into the next one present.
      }
      const durationMs = Math.max(0, at - previousMs);
      phases.push({
        label: milestone.label,
        blames: milestone.blames,
        durationMs,
        share: durationMs / total,
        dominant: false,
      });
      previousMs = at;
    }
    const worst = phases.reduce(
      (best, phase) => (phase.durationMs > (best?.durationMs ?? -1) ? phase : best),
      null as LatencyPhase | null,
    );
    if (worst) {
      worst.dominant = true;
    }
  }

  return {
    toFirstTokenMs:
      startMs !== null && firstTokenMs !== null
        ? Math.max(0, firstTokenMs - startMs)
        : null,
    firstTokenKind,
    startsAtStreamOpen: startKey === "open",
    phases,
  };
}
