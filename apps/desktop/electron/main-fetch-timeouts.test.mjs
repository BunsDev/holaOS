import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * Node's fetch has no default timeout. A backend that accepts the connection
 * but never responds therefore leaves the caller pending for undici's ~300s
 * headersTimeout, which reaches the user as a spinner that never resolves and
 * never errors. These guards pin the two places where that was worst.
 */

test("the shared main-process fetch helper bounds every attempt", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const MAIN_FETCH_TIMEOUT_MS = /);

  const helper = source.slice(
    source.indexOf("async function fetchWithNetworkRetry"),
  );
  const body = helper.slice(0, helper.indexOf("\n}\n") + 3);

  assert.match(
    body,
    /AbortSignal\.timeout\(MAIN_FETCH_TIMEOUT_MS\)/,
    "fetchWithNetworkRetry no longer applies a timeout",
  );
  // A caller-supplied signal must be combined with the deadline, not dropped —
  // otherwise an explicit shorter timeout or a cancellation stops working.
  assert.match(
    body,
    /AbortSignal\.any\(\[callerSignal, timeoutSignal\]\)/,
    "caller signal is no longer combined with the timeout",
  );
  // Both the first attempt and the retry must build their own signal; sharing
  // one hands the retry an already-aborted deadline.
  assert.equal(
    body.match(/initWithDeadline\(\)/g)?.length,
    2,
    "both the first attempt and the retry must build their own deadline",
  );
});

test("the session lookup that gates the shell is bounded", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // Anchor on the call itself: the path also appears in a nearby comment.
  const index = source.indexOf("fetch(`${AUTH_BASE_URL}/api/auth/get-session`");
  assert.notEqual(index, -1, "get-session request not found in main.ts");
  // RequireAuth holds the whole shell on this promise, so an unanswered
  // request here is a permanent boot splash with no error path.
  const request = source.slice(index, index + 400);
  assert.match(
    request,
    /signal: AbortSignal\.timeout\(/,
    "the get-session request no longer carries a timeout",
  );
});

test("the streaming employee-chat request is deliberately left unbounded", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // Counterpart to the guards above: an SSE response is long-lived by design,
  // so blanket-applying the request timeout to it would cut live streams off.
  const index = source.indexOf("Accept: \"text/event-stream\"");
  assert.notEqual(index, -1, "employee chat stream request not found");
  const request = source.slice(index - 400, index + 400);
  assert.doesNotMatch(
    request,
    /AbortSignal\.timeout\(MAIN_FETCH_TIMEOUT_MS\)/,
    "the SSE stream must not inherit the request/response timeout",
  );
});
