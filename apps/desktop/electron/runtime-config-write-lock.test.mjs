import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

const LOCK = "withRuntimeConfigMutationLock(";
const WRITE = "writeRuntimeConfigTextAtomically(";

/** Offsets of every occurrence of `needle`, ignoring its own declaration. */
function callSites(source, needle) {
  const sites = [];
  for (
    let index = source.indexOf(needle);
    index !== -1;
    index = source.indexOf(needle, index + 1)
  ) {
    const lineStart = source.lastIndexOf("\n", index) + 1;
    const line = source.slice(lineStart, index);
    if (/\b(async\s+)?function\s*$/.test(line)) {
      continue; // the declaration itself, not a call
    }
    sites.push(index);
  }
  return sites;
}

test("runtime config is written atomically via a temp file and rename", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /async function writeRuntimeConfigTextAtomically\(/);
  // A partial write to the live config file would leave the desktop unable to
  // reach its runtime, so the write must land through a rename.
  assert.match(source, /const tempPath = `\$\{configPath\}[^`]*\.tmp`;/);
  assert.match(source, /await fs\.writeFile\(tempPath, nextText/);
  assert.match(source, /await fs\.rename\(tempPath, configPath\)/);
});

test("the runtime config mutation lock serializes in-flight writers", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /async function withRuntimeConfigMutationLock<T>\(/);
  // Whatever the surrounding shape, the lock has to await an in-flight
  // mutation before starting its own.
  assert.match(
    source,
    /while \(runtimeConfigMutationPromise\)\s*\{\s*await runtimeConfigMutationPromise;/,
  );
});

test("every runtime config writer acquires the mutation lock first", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  const writes = callSites(source, WRITE);
  assert.ok(writes.length > 0, "no writeRuntimeConfigTextAtomically call sites");

  for (const write of writes) {
    const lock = source.lastIndexOf(LOCK, write);
    // Nearest preceding function declaration — the lock must be acquired
    // after it, i.e. inside the same function as the write, not merely
    // somewhere earlier in the file.
    const enclosing = Math.max(
      source.lastIndexOf("\nasync function ", write),
      source.lastIndexOf("\nfunction ", write),
    );
    const line = source.slice(0, write).split("\n").length;
    assert.ok(
      lock !== -1 && lock > enclosing,
      `writeRuntimeConfigTextAtomically at main.ts:${line} is not inside a withRuntimeConfigMutationLock block`,
    );
  }
});
