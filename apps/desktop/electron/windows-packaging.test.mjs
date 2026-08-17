import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, "..", "scripts");
const npmRunnerPath = path.join(scriptsDir, "npm-runner.mjs");

/**
 * This file used to also assert the CI workflow gated the Windows release on a
 * `release_windows` dispatch input. That input was removed when Windows became
 * an unconditional part of the release, so the assertion was pinning a decision
 * that had been reversed; it is gone rather than resurrected.
 *
 * What remains is the invariant that still bites: on Windows, `spawnSync("npm")`
 * fails with ENOENT whenever a version manager (mise, nvm, fnm) or Electron
 * leaves npm off PATH in a nested spawn. Every helper script must therefore go
 * through the shared runner.
 */

test("the npm runner resolves npm without relying on PATH", async () => {
  const source = await readFile(npmRunnerPath, "utf8");

  // Preferred: run npm's CLI entry under the current node binary.
  assert.match(source, /process\.env\.npm_execpath/);
  assert.match(source, /command: process\.execPath/);
  // Windows fallback: npm.cmd is a batch file, so it needs a shell — and it
  // must be spawned via ComSpec rather than as a bare `command: "npm.cmd"`,
  // which does not resolve.
  assert.match(source, /process\.env\.ComSpec \|\| "cmd\.exe"/);
  assert.match(source, /argsPrefix: \["\/d", "\/s", "\/c", "npm\.cmd"\]/);
  assert.doesNotMatch(source, /command: "npm\.cmd"/);
});

test("no desktop helper script spawns npm directly", async () => {
  const entries = await readdir(scriptsDir);
  const helpers = entries.filter(
    (name) => name.startsWith("ensure-") && name.endsWith(".mjs"),
  );
  assert.ok(helpers.length > 0, "no ensure-*.mjs helper scripts found");

  for (const helper of helpers) {
    const source = await readFile(path.join(scriptsDir, helper), "utf8");
    if (!/\bnpm\b/.test(source)) {
      continue; // helper has no npm involvement at all
    }
    assert.doesNotMatch(
      source,
      /spawnSync\(\s*"npm"/,
      `scripts/${helper} spawns npm directly instead of using runNpm`,
    );
  }
});
