import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  collectWorkspaceFileManifest,
  detectWorkspaceFileOutputs,
} from "./turn-output-capture.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-output-capture-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("detects a new deliverable under the capture root", () => {
  const home = makeTempDir();
  const captureRoot = path.join(home, "outputs");
  fs.mkdirSync(captureRoot, { recursive: true });

  const before = collectWorkspaceFileManifest(captureRoot);
  assert.equal(before.entries.size, 0);

  fs.writeFileSync(path.join(captureRoot, "brief.docx"), "deliverable");

  const outputs = detectWorkspaceFileOutputs({
    workspaceDir: captureRoot,
    before,
  });

  assert.equal(outputs.length, 1);
  const [output] = outputs;
  assert.equal(output.filePath, "brief.docx");
  assert.equal(output.title, "brief.docx");
  assert.equal(output.outputType, "document");
  assert.equal(output.metadata.change_type, "created");
});

test("joining the relative path with the capture root yields an absolute path", () => {
  const home = makeTempDir();
  const captureRoot = path.join(home, "outputs");
  fs.mkdirSync(captureRoot, { recursive: true });

  const before = collectWorkspaceFileManifest(captureRoot);
  fs.writeFileSync(path.join(captureRoot, "report.xlsx"), "data");

  const [output] = detectWorkspaceFileOutputs({
    workspaceDir: captureRoot,
    before,
  });

  const absolute = path.join(captureRoot, output.filePath);
  assert.ok(path.isAbsolute(absolute));
  assert.equal(absolute, path.join(captureRoot, "report.xlsx"));
  assert.ok(fs.existsSync(absolute));
});

test("general-session capture root is HOME/outputs; project-session root is the project dir", () => {
  const home = makeTempDir();
  const projectDir = makeTempDir();

  const resolveCaptureRoot = (agentCwd: string) =>
    agentCwd === home ? path.join(agentCwd, "outputs") : agentCwd;

  assert.equal(resolveCaptureRoot(home), path.join(home, "outputs"));
  assert.equal(resolveCaptureRoot(projectDir), projectDir);
});

test("never captures runtime-managed workspace control files", () => {
  const workspaceDir = makeTempDir();

  const before = collectWorkspaceFileManifest(workspaceDir);

  // The runtime rewrites these itself during a turn (e.g. MCP registry sync
  // rewrites workspace.yaml); they must not surface as deliverable outputs.
  fs.writeFileSync(path.join(workspaceDir, "workspace.yaml"), "agents:\n  id: holaboss\n");
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{}");
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "# Holaboss\n");
  fs.mkdirSync(path.join(workspaceDir, "apps", "twitter"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "apps", "twitter", "app.runtime.yaml"), "lifecycle: {}\n");
  fs.writeFileSync(path.join(workspaceDir, "brief.docx"), "deliverable");

  const outputs = detectWorkspaceFileOutputs({
    workspaceDir,
    before,
  });

  assert.deepEqual(
    outputs.map((output) => output.filePath),
    ["brief.docx"],
  );
});

test("ignores files that existed before the run", () => {
  const captureRoot = makeTempDir();
  fs.writeFileSync(path.join(captureRoot, "old.docx"), "existing");

  const before = collectWorkspaceFileManifest(captureRoot);
  fs.writeFileSync(path.join(captureRoot, "fresh.docx"), "new");

  const outputs = detectWorkspaceFileOutputs({
    workspaceDir: captureRoot,
    before,
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].filePath, "fresh.docx");
});

test("capped tool-result spills are not captured as outputs", () => {
  // Observed live twice: a 240KB overflow file rendered beside the answer as a
  // "Document · TXT" deliverable nobody asked for. Moving the spill from
  // outputs/ to tmp/ did NOT fix it on its own — this capture diffs a
  // before/after manifest of the WHOLE workspace, so location was never the
  // criterion. The skip list is.
  const workspace = makeTempDir();
  const before = collectWorkspaceFileManifest(workspace);

  fs.mkdirSync(path.join(workspace, "tmp", ".tool-results"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "tmp", ".tool-results", "call_tool-call_fc4f2368.txt"),
    "x".repeat(1024),
  );
  // The legacy location too, since existing workspaces still spill there.
  fs.mkdirSync(path.join(workspace, "outputs", ".tool-results"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspace, "outputs", ".tool-results", "composio_execute_tool-call_862f.txt"),
    "y".repeat(1024),
  );
  // A genuine deliverable must still be captured.
  fs.mkdirSync(path.join(workspace, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "outputs", "report.md"), "# real");

  const outputs = detectWorkspaceFileOutputs({
    workspaceDir: workspace,
    before,
  });

  assert.deepEqual(
    outputs.map((output) => output.filePath),
    ["outputs/report.md"],
    "only the real deliverable should surface",
  );
});

test("scratch under tmp/ is not a deliverable", () => {
  // tmp/ should mean what it says: working state for the turn.
  const workspace = makeTempDir();
  const before = collectWorkspaceFileManifest(workspace);
  fs.mkdirSync(path.join(workspace, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "tmp", "scratch.json"), "{}");

  assert.deepEqual(
    detectWorkspaceFileOutputs({ workspaceDir: workspace, before }),
    [],
  );
});
