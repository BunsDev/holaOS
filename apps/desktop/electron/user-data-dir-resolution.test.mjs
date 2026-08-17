import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const desktopPackageJsonPath = path.join(__dirname, "..", "package.json");

test("desktop user-data dir honors configured env before the dev fallback", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  // The env override has to be consulted, and it has to win over the
  // dev/prod default rather than the other way round — getting this backwards
  // silently points a configured desktop at the wrong profile directory.
  assert.match(
    source,
    /const configuredDesktopUserDataDir =\s*process\.env\.HOLABOSS_DESKTOP_USER_DATA_DIR/,
  );
  assert.match(
    source,
    /const DESKTOP_USER_DATA_DIR = \(\s*configuredDesktopUserDataDir \|\|/,
  );
  assert.match(source, /isDev \? "holaboss-local-dev" : "holaboss-local"/);
  // Path separators are collapsed so a configured value can never escape the
  // appData root.
  assert.ok(
    source.includes('.replace(/[\\\\/]+/g, "_")'),
    "configured user-data dir no longer collapses path separators",
  );
});

test("desktop dev script does not override HOLABOSS_DESKTOP_USER_DATA_DIR", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackageJsonPath, "utf8"));

  // `dev` used to invoke concurrently directly and now goes through
  // scripts/run-dev.mjs; either is fine. What must stay true is that it does
  // not pin the user-data dir, which would override a developer's own env.
  assert.ok(packageJson.scripts?.dev, "no dev script in package.json");
  assert.equal(
    packageJson.scripts.dev.includes("HOLABOSS_DESKTOP_USER_DATA_DIR="),
    false,
  );
});
