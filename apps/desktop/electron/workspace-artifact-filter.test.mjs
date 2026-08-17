import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * The body of `shouldHideWorkspaceManagedArtifactOutput`.
 *
 * The previous version pinned its `return` as one verbatim expression, so it
 * broke when `segments[0] === "apps"` was added to also hide app-internal
 * files — a widening of exactly the behavior it was meant to protect. These
 * assertions check each hidden class independently, so adding another one is
 * not a failure.
 */
function filterBody(source) {
  const start = source.indexOf(
    "function shouldHideWorkspaceManagedArtifactOutput(",
  );
  assert.notEqual(start, -1, "artifact filter not found in main.ts");
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

test("workspace-managed scaffolding is hidden from renderer output lists", async () => {
  const body = filterBody(await readFile(mainSourcePath, "utf8"));

  // agents.md and skills/ are written by the workspace itself; surfacing them
  // as user outputs is what this filter exists to prevent.
  assert.match(body, /fileName === "agents\.md"/);
  assert.match(body, /segments\.includes\("skills"\)/);
});

test("the artifact filter is actually applied to the output listing", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // A filter nothing calls is the failure mode worth guarding against.
  assert.match(
    source,
    /\.filter\(\s*\(item\) => !shouldHideWorkspaceManagedArtifactOutput\(item\),?\s*\)/,
  );
});
