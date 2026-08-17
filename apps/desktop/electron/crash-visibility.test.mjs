import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * Registering an `uncaughtException` listener suppresses Electron's own error
 * dialog and its non-zero exit, so these handlers ARE the entire crash story
 * for the main process. A packaged app has no terminal, so a handler that only
 * reaches console leaves every production crash invisible.
 */

test("main-process crashes are recorded somewhere a packaged build can surface", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /process\.on\("uncaughtException"/,
    "the uncaughtException handler is gone",
  );
  assert.match(
    source,
    /process\.on\("unhandledRejection"/,
    "the unhandledRejection handler is gone",
  );

  const handler = source.slice(
    source.indexOf("function recordMainProcessCrash"),
  );
  const body = handler.slice(0, handler.indexOf("\n}\n") + 3);
  assert.ok(body.length > 0, "recordMainProcessCrash not found");

  // console alone is not a crash record in a packaged app. runtime.log is what
  // the diagnostics bundle collects, so it is the one destination that makes a
  // shipped crash recoverable after the fact.
  assert.match(
    body,
    /appendRuntimeLog\(/,
    "crashes no longer reach runtime.log, so packaged crashes are invisible again",
  );

  // Both handlers must route through it — an inlined console.error in either
  // one is the regression this guards.
  const crashBlock = source.slice(
    source.indexOf("function recordMainProcessCrash"),
    source.indexOf('process.on("unhandledRejection"') + 400,
  );
  assert.equal(
    crashBlock.match(/recordMainProcessCrash\(/g)?.length,
    3,
    "expected recordMainProcessCrash to be declared once and called by both handlers",
  );
});

test("EPIPE stays suppressed and everything else does not", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const index = source.indexOf('process.on("uncaughtException"');
  const handler = source.slice(index, index + 400);

  // EPIPE on stdio writes is a benign teardown race Electron would otherwise
  // show as an error modal. It is the ONLY thing that may be swallowed.
  assert.match(handler, /err\?\.code === "EPIPE"/);
  assert.match(handler, /recordMainProcessCrash\("uncaughtException", err\)/);
});
