import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { RuntimeStateStore } from "./store.js";

// listWorkspaceLexicalSupportHits issues ONE listSemanticMemoryNodes query per
// integration tree on every turn. On a real workspace (603 trees / 69k nodes)
// that cost 26s of synchronous CPU per turn because the planner fell back to the
// UNIQUE (workspace_id, category, path) autoindex — that index satisfies the
// `ORDER BY path` prefix, so it skips the sort but then filters the whole table
// once per tree.
//
// The fix is BOTH an index and an ANALYZE. Shipping only the index measurably
// does nothing (25.8s -> 25.5s), because without sqlite_stat1 the planner still
// prefers the autoindex. These tests pin both halves.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): { store: RuntimeStateStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-smn-index-"));
  tempDirs.push(root);
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "state", "host-state.db"),
    controlPlaneDbPath: path.join(root, "state", "control-plane.db"),
    workspaceRoot: path.join(root, "workspaces"),
  });
  return { store, root };
}

/** Force the workspace runtime db to exist, then open it directly to inspect schema. */
function openWorkspaceDb(store: RuntimeStateStore, root: string): Database.Database {
  store.listSemanticMemoryNodes({ category: "workspace", workspaceId: "root", limit: 1 });
  const dbPath = path.join(root, "state", "data.db");
  assert.ok(fs.existsSync(dbPath), `expected workspace runtime db at ${dbPath}`);
  return new Database(dbPath, { readonly: true });
}

test("semantic_memory_nodes carries the per-tree candidate-pool index", () => {
  const { store, root } = makeStore();
  const db = openWorkspaceDb(store, root);
  try {
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_semantic_memory_nodes_tree_class_status_path'`,
      )
      .get() as { sql?: string } | undefined;
    assert.ok(idx, "expected idx_semantic_memory_nodes_tree_class_status_path to exist");

    // Column ORDER is the whole point: the five equality predicates
    // (workspace_id, category, tree_id, node_class, status) must lead so each
    // per-tree lookup is a seek rather than a filtered scan.
    const cols = db
      .prepare("PRAGMA index_info('idx_semantic_memory_nodes_tree_class_status_path')")
      .all()
      .map((c) => (c as { name: string }).name);
    assert.deepEqual(cols, ["workspace_id", "category", "tree_id", "node_class", "status", "path"]);
  } finally {
    db.close();
  }
});

test("opening the store ANALYZEs semantic_memory_nodes so the planner can use that index", () => {
  const { store, root } = makeStore();
  const db = openWorkspaceDb(store, root);
  try {
    // Without stats the planner ignores the new index entirely, so the index
    // alone is not a fix. Assert ANALYZE actually ran.
    const stat = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1' LIMIT 1")
      .get();
    assert.ok(stat, "expected ANALYZE to have created sqlite_stat1");

    const marker = db
      .prepare("SELECT marker FROM semantic_memory_planner_stats LIMIT 1")
      .get() as { marker?: string } | undefined;
    assert.equal(marker?.marker, "semantic_memory_nodes_analyze_v1");
  } finally {
    db.close();
  }
});

test("ANALYZE is not re-run on every open", () => {
  const { store, root } = makeStore();
  openWorkspaceDb(store, root).close();

  const dbPath = path.join(root, "state", "data.db");
  const write = new Database(dbPath);
  const before = write
    .prepare("SELECT applied_at FROM semantic_memory_planner_stats WHERE marker = ?")
    .get("semantic_memory_nodes_analyze_v1") as { applied_at: string };
  write.close();

  // Reopen: the marker gates the work, so applied_at must be untouched.
  const reopened = new RuntimeStateStore({
    dbPath: path.join(root, "state", "host-state.db"),
    controlPlaneDbPath: path.join(root, "state", "control-plane.db"),
    workspaceRoot: path.join(root, "workspaces"),
  });
  const db = openWorkspaceDb(reopened, root);
  try {
    const after = db
      .prepare("SELECT applied_at FROM semantic_memory_planner_stats WHERE marker = ?")
      .get("semantic_memory_nodes_analyze_v1") as { applied_at: string };
    assert.equal(after.applied_at, before.applied_at, "ANALYZE should be gated by the marker");
  } finally {
    db.close();
  }
});
