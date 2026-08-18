import { runPi, defaultPiDeps } from "./pi.js";
import type { HarnessHostPiRequest } from "./contracts.js";

/**
 * Run pi inside the CALLER's process instead of spawning harness-host.
 *
 * Why this lives in harness-host rather than api-server: pi is installed here,
 * and `postinstall: apply-pi-patches.mjs` patches THIS package's node_modules.
 * A copy of pi resolved from api-server would run unpatched, so the fidelity the
 * subprocess has today would not transfer. Keeping the entry point on this side
 * of the boundary keeps one pi install and one patch set.
 *
 * The saving is one whole process boot — fork + V8 init + node bootstrap +
 * module resolution. The pi module graph still has to load; it just loads in a
 * V8 that is already running, with a warm module cache.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * This function exists to preserve, by hand, the guarantees the subprocess was
 * providing for free. Each was a silent failure waiting to happen:
 *
 *  - `sawEvent` / `terminalEmitted` / `lastSequence` are computed from the
 *    events actually relayed. The debug CLI's adapter hardcodes them to `true`,
 *    and copying that would make every non-terminating run (OOM, unhandled
 *    rejection in a tool, native abort) report clean — the caller would see no
 *    terminal event and hang to its 30-minute timeout instead of failing fast.
 *
 *  - A throw AFTER the terminal event is reported separately from one before.
 *    pi emits `run_completed` and *then* runs compaction and dispose in its
 *    `finally`; in-process, a throw from either would otherwise look like a
 *    failed turn, and the caller's failure path clears the persisted
 *    `harness_session_id` — losing the user's conversation after a turn that
 *    actually succeeded.
 *
 *  - Events relay through an ordered promise chain. `PiDeps.emitEvent` is
 *    synchronous and does not await, but the caller's `emitEvent` persists the
 *    harness session id. Fire-and-forget would let a later event's relay overtake
 *    an earlier one and let this function return before persistence finished.
 *
 *  - A first-event watchdog replaces the one the subprocess got from being
 *    killable. Without it, a bootstrap step that blocks forever (an MCP
 *    transport that never opens) has nothing to interrupt it.
 */

/** Terminal event types, mirroring the caller's own set. Duplicated rather than
 *  imported because api-server does not export it and this package must not
 *  depend on api-server (the dependency runs the other way). */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run_completed",
  "run_failed",
]);

export interface InProcessRunnerEvent {
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** Injection seam. The real implementations are the defaults; tests replace
 *  `runPi` so they can exercise the adapter's bookkeeping — which is where every
 *  one of the blockers lives — without a real model turn. */
export interface RunPiInProcessDeps {
  runPi: typeof runPi;
  defaultPiDeps: typeof defaultPiDeps;
}

export interface RunPiInProcessParams {
  requestPayload: unknown;
  deps?: Partial<RunPiInProcessDeps>;
  /** Relay. Awaited in order; a rejection is captured, never thrown at pi. */
  emitEvent: (event: InProcessRunnerEvent) => Promise<void>;
  /** Kill switch for a run that emits nothing. 0 disables. */
  firstEventTimeoutMs?: number;
  logger?: { warn: (message: string) => void; error?: (message: string) => void };
}

export interface RunPiInProcessResult {
  exitCode: number;
  stderr: string;
  sawEvent: boolean;
  terminalEmitted: boolean;
  lastSequence: number;
  /** Time to the first relayed event. The subprocess path reports spawn → first
   *  event here; in-process there is no spawn, so this is call → first event and
   *  should be dramatically smaller. That difference IS the win being measured. */
  harnessSpawnToFirstEventMs?: number;
  harnessSpawnToFirstTokenMs?: number;
  /** Set when pi threw after emitting a terminal event. The turn SUCCEEDED; this
   *  is post-turn cleanup (compaction, dispose) failing. The caller must not
   *  treat it as a failed run — doing so clears the resume pointer. */
  postTerminalError?: string | null;
}

export async function runPiInProcess(
  params: RunPiInProcessParams,
): Promise<RunPiInProcessResult> {
  const request = params.requestPayload as HarnessHostPiRequest;
  const runPiImpl = params.deps?.runPi ?? runPi;
  const piDeps = params.deps?.defaultPiDeps ?? defaultPiDeps;
  const startedAtMs = Date.now();

  let sawEvent = false;
  let terminalEmitted = false;
  let lastSequence = 0;
  let firstEventAtMs: number | null = null;
  let firstTokenAtMs: number | null = null;
  let firstEventTimedOut = false;

  // Ordered relay. Each event waits for the previous one, so the caller sees
  // them in emission order and this function can await the whole chain before
  // returning — which is what makes the session-id persistence safe.
  let relayChain: Promise<void> = Promise.resolve();
  const relayErrors: string[] = [];

  const timeoutMs = params.firstEventTimeoutMs ?? 0;
  let firstEventTimer: NodeJS.Timeout | null = null;
  const abort = new AbortController();
  if (timeoutMs > 0) {
    firstEventTimer = setTimeout(() => {
      if (sawEvent) {
        return;
      }
      firstEventTimedOut = true;
      // There is no child to SIGKILL. Abort is advisory: it unblocks anything
      // that honours the signal, and the timeout is reported either way so a
      // wedged run is visible instead of silently pending.
      abort.abort();
      params.logger?.warn(
        `harness in-process: no events within ${timeoutMs}ms; aborting`,
      );
    }, timeoutMs);
    // Never hold the process open on this timer alone.
    firstEventTimer.unref?.();
  }
  const clearFirstEventTimer = (): void => {
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
  };

  const emitAdapter = (
    piRequest: HarnessHostPiRequest,
    sequence: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): void => {
    // Bookkeeping happens SYNCHRONOUSLY, before the relay is queued: it must
    // describe what pi emitted, not what the relay managed to deliver. A relay
    // that fails still means the event happened, and `terminalEmitted` in
    // particular decides whether the caller synthesizes a failure.
    if (!sawEvent) {
      clearFirstEventTimer();
    }
    sawEvent = true;
    lastSequence = Math.max(lastSequence, sequence);
    const now = Date.now();
    if (firstEventAtMs === null) {
      firstEventAtMs = now;
    }
    if (
      firstTokenAtMs === null &&
      (eventType === "output_delta" || eventType === "thinking_delta")
    ) {
      firstTokenAtMs = now;
    }
    if (TERMINAL_EVENT_TYPES.has(eventType)) {
      terminalEmitted = true;
    }

    const event: InProcessRunnerEvent = {
      session_id: piRequest.session_id,
      input_id: piRequest.input_id,
      sequence,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      payload,
    };
    relayChain = relayChain.then(
      () => params.emitEvent(event),
      // A prior rejection must not poison the rest of the chain.
      () => params.emitEvent(event),
    ).catch((error: unknown) => {
      relayErrors.push(error instanceof Error ? error.message : String(error));
    });
  };

  let exitCode = 0;
  let preTerminalError: string | null = null;
  let postTerminalError: string | null = null;

  try {
    exitCode = await runPiImpl(request, {
      ...piDeps(),
      emitEvent: emitAdapter,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (terminalEmitted) {
      // The turn finished. This is pi's post-terminal cleanup failing —
      // reporting it as a failed run would clear the resume pointer and cost
      // the user their conversation.
      postTerminalError = message;
      params.logger?.warn(
        `harness in-process: post-terminal error (turn already completed): ${message}`,
      );
    } else {
      preTerminalError = message;
      exitCode = 1;
    }
  } finally {
    clearFirstEventTimer();
    // Drain before returning: the caller's relay persists the harness session
    // id, and returning early would race the next turn's resume.
    await relayChain;
  }

  const stderr = [
    preTerminalError ? `harness in-process error: ${preTerminalError}` : "",
    firstEventTimedOut
      ? `harness in-process produced no events within ${timeoutMs}ms`
      : "",
    ...relayErrors.map((message) => `event relay failed: ${message}`),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return {
    exitCode,
    stderr,
    sawEvent,
    terminalEmitted,
    lastSequence,
    harnessSpawnToFirstEventMs:
      firstEventAtMs === null ? undefined : firstEventAtMs - startedAtMs,
    harnessSpawnToFirstTokenMs:
      firstTokenAtMs === null ? undefined : firstTokenAtMs - startedAtMs,
    postTerminalError,
  };
}
