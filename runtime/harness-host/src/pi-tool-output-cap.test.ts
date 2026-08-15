import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolOutputCapState, wrapToolWithOutputCap } from "./pi.js";

function textTool(bytes: number) {
  return {
    name: "read",
    execute: async (..._args: unknown[]) => ({
      content: [{ type: "text", text: "z".repeat(bytes) }],
    }),
  };
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

test("wrapToolWithOutputCap tightens once the run's inlined tool output crosses the session budget", async () => {
  const prev = {
    max: process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES,
    budget: process.env.HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES,
    tight: process.env.HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES,
  };
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(50 * 1024);
  process.env.HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES = String(40 * 1024);
  process.env.HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES = String(8 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-"));
  try {
    // One shared accumulator across every wrapped tool — like a runPi.
    const state = createToolOutputCapState();
    const call = (bytes: number) =>
      wrapToolWithOutputCap(textTool(bytes), root, state).execute("call", {});

    // Under the 50KB per-call cap AND under the 40KB session budget → inlined.
    const r1 = await call(20 * 1024);
    assert.equal(r1.content[0].text.length, 20 * 1024);
    // Still under budget when this call starts (20KB inlined) → inlined; now 45KB total.
    const r2 = await call(25 * 1024);
    assert.equal(r2.content[0].text.length, 25 * 1024);
    // Cumulative inlined (45KB) has crossed the 40KB budget → cap tightens to
    // 8KB → this 20KB result is offloaded (stubbed), not inlined.
    const r3 = await call(20 * 1024);
    assert.match(r3.content[0].text, /Tool output truncated/);
    assert.ok(r3.content[0].text.length < 20 * 1024, "offloaded result should be a short stub");
    // A small (4KB) result still passes even after the budget is spent.
    const r4 = await call(4 * 1024);
    assert.equal(r4.content[0].text.length, 4 * 1024);
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prev.max);
    restoreEnv("HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES", prev.budget);
    restoreEnv("HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES", prev.tight);
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapToolWithOutputCap without a shared accumulator applies only the per-call cap", async () => {
  const prevMax = process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES;
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(50 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-"));
  try {
    // No shared state → each wrapper accumulates independently; a 20KB result
    // (under the 50KB per-call cap) always inlines, no matter how many times.
    for (let i = 0; i < 10; i += 1) {
      const r = await wrapToolWithOutputCap(textTool(20 * 1024), root).execute("c", {});
      assert.equal(r.content[0].text.length, 20 * 1024, `call ${i} should inline`);
    }
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prevMax);
    rmSync(root, { recursive: true, force: true });
  }
});

// A real turn ("list my recent github issues") returned 57KB, blew the cap, and
// got back nothing but a file path — so the agent spent FOUR bash calls writing
// python to discover where in the `{content:[{text}],details:{}}` envelope the
// payload lived before it could answer. An over-cap result must therefore still
// carry a usable head of the payload, and the offloaded file must be the payload
// itself rather than the envelope.
test("an over-cap result returns a head preview of the payload, not just a pointer", async () => {
  const prev = process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES;
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(16 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-preview-"));
  try {
    const payload = Array.from({ length: 4000 }, (_, i) => `issue-${i}`).join("\n");
    const tool = {
      name: "call_tool",
      execute: async (..._args: unknown[]) => ({
        content: [{ type: "text", text: payload }],
        details: { tool_slug: "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS" },
      }),
    };
    const out = await wrapToolWithOutputCap(tool, root, createToolOutputCapState())
      .execute("call-1", {});
    const text = out.content[0].text as string;

    assert.match(text, /Tool output truncated/, "still says it was truncated");
    assert.match(text, /end of preview/, "carries a preview block");
    assert.ok(text.includes("issue-0"), "preview starts at the head of the payload");
    assert.ok(!text.includes(`issue-3999`), "preview is only the head, not everything");
    // the whole replacement must stay comfortably under the per-call cap
    assert.ok(
      Buffer.byteLength(text, "utf8") < 16 * 1024,
      `replacement (${Buffer.byteLength(text, "utf8")}B) must stay under the cap`,
    );
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the offloaded file holds the payload verbatim (.txt), not the result envelope", async () => {
  const prev = process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES;
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(4 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-file-"));
  try {
    const payload = "LINE-A\n" + "x".repeat(8 * 1024) + "\nLINE-Z";
    const tool = {
      name: "call_tool",
      execute: async (..._args: unknown[]) => ({
        content: [{ type: "text", text: payload }],
        details: { noise: "envelope-only field" },
      }),
    };
    const out = await wrapToolWithOutputCap(tool, root, createToolOutputCapState())
      .execute("call-2", {});
    const text = out.content[0].text as string;
    const match = text.match(/saved verbatim at (\S+)/);
    assert.ok(match, `expected a saved path in: ${text.slice(0, 160)}`);
    const rel = match[1];
    assert.match(rel, /\.txt$/, "text payloads are written as .txt, not .json");
    const onDisk = readFileSync(join(root, rel), "utf8");
    assert.equal(onDisk, payload, "file is the payload verbatim — directly readable");
    assert.ok(!onDisk.includes("envelope-only field"), "no envelope wrapper to parse");
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prev);
    rmSync(root, { recursive: true, force: true });
  }
});
