import assert from "node:assert/strict";
import test from "node:test";

import { persistTurnOutputArtifactsAsDocuments } from "./workspace-attachment-memory.js";

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
