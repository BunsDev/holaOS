import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * Parse the DEV_SHELL_CSP array literal into a `directive -> sources` map.
 *
 * Asserting on the parsed policy instead of the verbatim header text is the
 * whole point of this file. The previous version pinned the exact frame-src
 * string and broke the moment `data:` was legitimately added for PDF preview —
 * so from then on it could not have caught a real loosening either, because it
 * was already failing. A structural check survives reformatting and additions
 * while still failing on the things that actually matter below.
 */
function parseDevShellCsp(source) {
  const block = source.match(
    /const DEV_SHELL_CSP = \[([\s\S]*?)\]\.join\("; "\);/,
  );
  assert.ok(block, "DEV_SHELL_CSP array literal not found in main.ts");

  const withoutComments = block[1].replace(/^\s*\/\/.*$/gm, "");
  const directives = new Map();
  for (const [, entry] of withoutComments.matchAll(/"([^"]+)"/g)) {
    const [name, ...sources] = entry.trim().split(/\s+/);
    directives.set(name, sources);
  }
  return directives;
}

test("dev shell CSP keeps its lockdown directives", async () => {
  const csp = parseDevShellCsp(await readFile(mainSourcePath, "utf8"));

  // These four are the policy's teeth and should never be relaxed, however
  // much the source-permitting directives grow.
  assert.deepEqual(csp.get("default-src"), ["'self'"]);
  assert.deepEqual(csp.get("object-src"), ["'none'"]);
  assert.deepEqual(csp.get("base-uri"), ["'self'"]);
  assert.deepEqual(csp.get("form-action"), ["'self'"]);
});

test("dev shell CSP still allows local app iframe origins", async () => {
  const csp = parseDevShellCsp(await readFile(mainSourcePath, "utf8"));
  const frameSrc = csp.get("frame-src");

  // The reason this policy exists: app surfaces render in renderer iframes
  // that resolve to local runtime ports during development.
  assert.ok(frameSrc, "frame-src directive is missing");
  for (const origin of ["'self'", "http://localhost:*", "http://127.0.0.1:*"]) {
    assert.ok(
      frameSrc.includes(origin),
      `frame-src no longer allows ${origin}: ${frameSrc.join(" ")}`,
    );
  }
});

test("no dev shell CSP directive is a bare wildcard", async () => {
  const csp = parseDevShellCsp(await readFile(mainSourcePath, "utf8"));

  for (const [directive, sources] of csp) {
    assert.ok(
      !sources.includes("*"),
      `${directive} is a bare wildcard, which defeats the directive: ${sources.join(" ")}`,
    );
  }
});
