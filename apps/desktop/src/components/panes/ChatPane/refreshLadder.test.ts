import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "index.tsx"), "utf-8");

/**
 * STRUCTURAL guard, in a `.test.ts` deliberately: `src/**` + `/*.test.mjs` is
 * gated by no CI job — `test:electron` globs `electron/`, `test:unit` globs
 * `.test.ts`/`.test.tsx` — so a guard written as `.mjs` under src/ would never
 * run. (ChatPane.test.mjs currently has 50 failing assertions nobody sees.)
 */

test("the refresh ladder stops once the turn it waits for has landed", () => {
  // Every rung re-derives the WHOLE conversation, so running all four
  // unconditionally costs three full rebuilds of every message after the data
  // has already converged — the bulk of the end-of-turn stutter on a long chat.
  assert.match(
    source,
    /const delays = \[150, 500, 1_500, 3_000\];/,
    "the retry curve stays — the persistence delay is still unknown",
  );
  assert.match(
    source,
    /const cancelRemaining = \(\) => \{[\s\S]*?window\.clearTimeout\(timer\)/,
    "the remaining rungs must be cancellable",
  );
  // Keyed on the awaited turn actually landing, not on a timer or a count.
  assert.match(
    source,
    /const stillPending =\s*pendingCommittedAssistantTurnsRef\.current\.some\(\s*\(message\) => message\.id === awaited,\s*\);\s*if \(!stillPending\) \{\s*cancelRemaining\(\);/,
  );
});

test("a ladder that names no turn still runs every rung", () => {
  // run_failed and the other callers converge on things this signal knows
  // nothing about, so they must keep the old behaviour exactly.
  assert.match(source, /if \(!awaited\) \{\s*return;\s*\}/);
});

test("the completion path names the turn it is waiting for", () => {
  assert.match(
    source,
    /scheduleConversationRefresh\(eventSessionId, selectedWorkspaceId, \{\s*awaitAssistantMessageId: committedAssistantMessage,\s*\}\);/,
  );
  // Which requires the commit to hand back an id rather than a bare boolean.
  assert.match(
    source,
    /function commitLiveAssistantMessage\(options\?: \{[\s\S]*?\}\): string \| null \{/,
  );
});

test("every terminal stream signal commits the live turn before the refresh", () => {
  // The end-of-response flicker had a second cause the first fix missed. Two
  // signals end a turn — the stream's `done` frame and the `run_completed`
  // event — and only the second committed the live turn. On the `done` path the
  // turn was still nothing but live state when the 150ms refresh landed, and
  // that refresh replaces `messages` with the server's list (which has not
  // persisted the turn yet) AND calls resetLiveTurn(). The turn belonged to
  // neither, so it vanished until the 500ms rung.
  //
  // preserveCommittedAssistantTurns cannot hold what was never committed, which
  // is why the flicker survived that fix on whichever path won the race.
  const doneHandler = source.match(
    /if \(payload\.type === "done"\) \{[\s\S]*?action: "applied_done"[\s\S]*?\n {10}return;/,
  )?.[0];
  assert.ok(doneHandler, "the done-frame handler should still be findable");

  assert.match(
    doneHandler,
    /const committedAssistantMessage = commitLiveAssistantMessage\(\);/,
    "the done frame must commit the live turn, or there is nothing to hold against the refresh",
  );
  assert.match(
    doneHandler,
    /awaitAssistantMessageId: committedAssistantMessage,/,
    "and the ladder must wait for that turn to be queryable",
  );

  // Ordering is the load-bearing part: commitLiveAssistantMessage derives the
  // message id from activeAssistantMessageIdRef, and that id has to equal the
  // server's `assistant-${inputId}` for the held copy to settle. Commit after
  // the ref is cleared and the id falls back to `assistant-${Date.now()}`,
  // which never matches — turning a 350ms flicker into a permanent duplicate.
  const commitAt = doneHandler.indexOf("commitLiveAssistantMessage()");
  const clearAt = doneHandler.indexOf("activeAssistantMessageIdRef.current = null");
  assert.ok(commitAt >= 0 && clearAt >= 0);
  assert.ok(
    commitAt < clearAt,
    "commit must precede clearing activeAssistantMessageIdRef, or the committed id cannot match the server's",
  );
});

test("the refresh discards the live turn, which is why committing first matters", () => {
  // This is the other half of the flicker: the refresh path resets the live
  // turn unconditionally. That is intended — the server's copy supersedes the
  // local one — but it means any terminal path that fails to commit first is
  // silently throwing the turn away. Pinned so that coupling stays visible.
  assert.match(
    source,
    /const shouldPreservePendingPlaceholder =\s*pendingInputIdRef\.current === STREAM_ATTACH_PENDING;\s*if \(!shouldPreservePendingPlaceholder\) \{\s*resetLiveTurn\(\);\s*\}/,
  );
});

test("a finished turn is not re-attached as a live run", () => {
  // Observed in a real trace: every turn ended with a SECOND stream open 36ms
  // after emit_done, replaying all ~60 events from sequence 1, every one of
  // which the renderer dropped as input_match=false. The cause is that the
  // re-attach predicate trusts the runtime's status (which lags the terminal
  // frame) while both stream refs being null is precisely what "just finished"
  // looks like.
  assert.match(
    source,
    /const runtimeInputAlreadyTerminated = Boolean\(\s*currentRuntimeInputId &&\s*terminalEventTypeByInputIdRef\.current\.has\(currentRuntimeInputId\),\s*\);/,
    "the predicate must consult the terminal-event map",
  );
  assert.match(
    source,
    /const shouldAttachLiveRunStream =\s*!activeStreamIdRef\.current &&\s*!pendingInputIdRef\.current &&\s*!runtimeInputAlreadyTerminated &&\s*\["BUSY", "QUEUED"\]\.includes\(currentRuntimeStatus\);/,
  );
  // The map has to still be written on both terminal paths, or the guard above
  // silently never fires.
  assert.match(
    source,
    /recordTerminalEventForInput\(\s*eventInputId,\s*"run_completed",\s*\)/,
  );
  assert.match(
    source,
    /recordTerminalEventForInput\(\s*eventInputId,\s*"run_failed",\s*\)/,
  );
});
