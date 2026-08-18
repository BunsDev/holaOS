import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * `app.whenReady()` runs ~2,600 lines: the state loads, all 249 IPC handler
 * registrations, createMainWindow(), and finally app.on("activate"). A throw
 * anywhere before the end takes out everything after it — including the window
 * and, on macOS, the dock-click that would rebuild it.
 *
 * These guard the two things that keep an ordinary disk/DB failure from
 * costing the user their window.
 */

test("the pre-window state loads cannot abort the ready chain", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // Each of these can throw on a read-only/full userData dir or a corrupt or
  // locked SQLite file, and none is needed to show a window.
  for (const step of [
    "loadBrowserPersistence",
    "loadBrowserProfiles",
    "loadFingerprintTemplates",
    "bootstrapRuntimeDatabase",
    "bootstrapControlPlaneDatabase",
  ]) {
    assert.match(
      source,
      new RegExp(`runBootStep\\(\\s*"[^"]+",\\s*${step},?\\s*\\)`),
      `${step} is no longer wrapped in runBootStep`,
    );
  }

  const helper = source.slice(source.indexOf("async function runBootStep"));
  const body = helper.slice(0, helper.indexOf("\n}\n") + 3);
  assert.match(body, /catch \(error\)/, "runBootStep no longer catches");
  // Degrading silently would be its own bug: runtime.log is what the
  // diagnostics bundle collects, so a degraded launch stays diagnosable.
  assert.match(body, /appendRuntimeLog\(/, "boot failures are no longer recorded");
});

test("the ready chain has a terminal catch", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  const index = source.indexOf("app.whenReady().then(async () => {");
  assert.notEqual(index, -1, "the main ready chain was not found");
  const tail = source.slice(index);

  // Registering process-level handlers suppresses Electron's own error dialog,
  // so an unhandled rejection here is a dock icon that does nothing, silently.
  assert.match(
    tail,
    /\}\)\s*\.catch\(\(error\) => \{/,
    "app.whenReady() no longer has a terminal .catch",
  );
  assert.match(tail, /dialog\.showErrorBox\(/, "boot failure is no longer surfaced");
});
