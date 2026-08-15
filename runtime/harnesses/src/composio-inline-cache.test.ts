import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearComposioInlineCache,
  composioInlineCachePath,
  readComposioInlineCache,
  writeComposioInlineCache,
} from "./composio-inline-cache.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "composio-cache-"));
}

const PAYLOAD = { tools: [{ name: "github_create_a_commit" }] };

test("round-trips a payload for the same workspace", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.deepEqual(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }),
    PAYLOAD,
  );
  assert.ok(fs.existsSync(composioInlineCachePath(dir)));
});

test("misses for a different workspace id (no cross-workspace leakage)", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "other" }), null);
});

test("misses once past the TTL, hits inside it", () => {
  const dir = tmpWorkspace();
  const t0 = 1_000_000;
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD, nowMs: t0 });
  assert.deepEqual(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + 60_000 }),
    PAYLOAD,
    "inside the 120s TTL",
  );
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + 300_000 }),
    null,
    "past the TTL",
  );
  // a clock that jumped backwards must not serve a 'future' entry
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 - 5_000 }),
    null,
  );
});

test("clear invalidates (the connect/install hook)", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(clearComposioInlineCache(dir), true);
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null);
  assert.equal(clearComposioInlineCache(dir), false, "second clear reports nothing to remove");
});

test("env kill-switch disables both read and write", () => {
  const dir = tmpWorkspace();
  const off = { HB_COMPOSIO_CACHE: "0" } as NodeJS.ProcessEnv;
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD, env: off });
  assert.equal(fs.existsSync(composioInlineCachePath(dir)), false, "nothing written");
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", env: off }),
    null,
    "read disabled even when a file exists",
  );
});

test("corrupt or foreign cache files are ignored, never thrown", () => {
  const dir = tmpWorkspace();
  const target = composioInlineCachePath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{not json");
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null);
  fs.writeFileSync(target, JSON.stringify({ version: 999, workspace_id: "root", fetched_at_ms: Date.now(), payload: PAYLOAD }));
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null, "version guard");
});

test("reading a workspace with no cache is a miss, not an error", () => {
  assert.equal(readComposioInlineCache({ workspaceDir: tmpWorkspace(), workspaceId: "root" }), null);
});
