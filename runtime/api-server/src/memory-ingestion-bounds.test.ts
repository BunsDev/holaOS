import assert from "node:assert/strict";
import test from "node:test";

import {
  persistTurnOutputArtifactsAsDocuments,
  splitAttachmentTextIntoChunks,
} from "./workspace-attachment-memory.js";

// Tool results are transcript/evidence, not durable memory. Before this filter
// they were 99.5% of one real workspace's semantic memory (69,146 of 69,463
// nodes; 512 of 603 trees), 56% of it base64 screenshot data indexed as prose.
// Durable capture is the agent-invoked `remember` tool.
//
// persistTurnOutputArtifactsAsDocuments returns early once the filter empties
// the list, so a store stub with only listOutputs exercises the real exported
// function. A sentinel on workspaceDir proves whether it got past the filter.

const SENTINEL = "reached-indexing";

function makeStore(outputs: Array<Record<string, unknown>>) {
  return {
    listOutputs: () => outputs,
    workspaceDir: () => {
      throw new Error(SENTINEL);
    },
  } as never;
}

const turnResult = {
  workspaceId: "root",
  sessionId: "s1",
  inputId: "i1",
  completedAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
} as never;

const WIN_TOOL_RESULT_DIR = [
  "C:",
  "Users",
  "x",
  "AppData",
  "Roaming",
  "holaboss-local",
  "sandbox-host",
  "workspace",
  "outputs",
  ".tool-results",
].join("\\");

function toolResultOutput(name: string, sep: "win" | "posix"): Record<string, unknown> {
  const filePath = sep === "win"
    ? `${WIN_TOOL_RESULT_DIR}\\${name}`
    : `/holaboss/workspace/outputs/.tool-results/${name}`;
  return { id: name, title: name, status: "active", filePath };
}

test("tool-result outputs are excluded from durable memory indexing", async () => {
  // Windows-style paths: this is what the desktop actually stores.
  const store = makeStore([
    toolResultOutput("mcp__adspower_local_api_auth__screenshot-call_abc.json", "win"),
    toolResultOutput("mcp__adspower_local_api_auth__get-page-visible-text-call_d.json", "win"),
  ]);
  const trees = await persistTurnOutputArtifactsAsDocuments({ store, turnResult });
  assert.deepEqual(trees, [], "expected no memory trees for tool-result outputs");
});

test("the exclusion is separator-agnostic (posix runtime paths too)", async () => {
  const store = makeStore([toolResultOutput("mcp__holapool__list_profiles-call_x.json", "posix")]);
  const trees = await persistTurnOutputArtifactsAsDocuments({ store, turnResult });
  assert.deepEqual(trees, [], "expected posix .tool-results paths to be excluded as well");
});

test("ordinary outputs are still indexed", async () => {
  // A real user artifact must NOT be filtered — it should reach indexing, which
  // the sentinel proves. Guarding against an over-broad match that silently
  // disables durable memory for genuine documents.
  const store = makeStore([
    { id: "o1", title: "report.md", status: "active", filePath: String.raw`C:\...\workspace\root\report.md` },
  ]);
  await assert.rejects(
    () => persistTurnOutputArtifactsAsDocuments({ store, turnResult }),
    (error: Error) => error.message === SENTINEL,
    "ordinary outputs must still reach the indexing path",
  );
});

test("deleted tool results and deleted ordinary outputs are both skipped", async () => {
  const store = makeStore([
    { ...toolResultOutput("screenshot-call_z.json", "win"), status: "deleted" },
    { id: "o2", title: "old.md", status: "deleted", filePath: String.raw`C:\...\workspace\root\old.md` },
  ]);
  const trees = await persistTurnOutputArtifactsAsDocuments({ store, turnResult });
  assert.deepEqual(trees, [], "deleted outputs should not be indexed");
});

// splitAttachmentTextIntoChunks is the single choke point for every ingestion
// path. It had no upper bound, so chunk count scaled with file size: one 2.1MB
// screenshot JSON produced 4,960 chunks. Excluding tool results removes today's
// worst offender, but a large attachment could reproduce it — hence the cap.

test("a huge document cannot produce unbounded chunks", () => {
  // ~2MB of paragraph-like text, the shape a big PDF/page dump extracts to.
  const huge = Array.from({ length: 4000 }, (_v, i) => `paragraph ${i} ${"x".repeat(500)}`).join("\n\n");
  const chunks = splitAttachmentTextIntoChunks(huge);
  assert.ok(
    chunks.length <= 200,
    `expected the ingestion cap to bound chunks, got ${chunks.length}`,
  );
});

test("a single enormous unbroken block is also capped", () => {
  // No paragraph breaks — exercises the sliding-window branch, which was the
  // path base64 blobs took (one long line with no structure).
  const blob = "A".repeat(2_000_000);
  const chunks = splitAttachmentTextIntoChunks(blob);
  assert.ok(
    chunks.length <= 200,
    `expected the sliding-window branch to respect the cap, got ${chunks.length}`,
  );
});

test("normal documents are unaffected by the cap", () => {
  const doc = ["# Title", "First paragraph.", "Second paragraph."].join("\n\n");
  const chunks = splitAttachmentTextIntoChunks(doc);
  assert.ok(chunks.length >= 1, "a small document should still chunk");
  assert.ok(chunks.length < 200, "a small document must not hit the cap");
  // Content must survive intact — the cap must not corrupt ordinary indexing.
  assert.ok(chunks.some((c) => c.content.includes("First paragraph.")));
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_v, i) => i), "chunk indexes stay sequential");
});
