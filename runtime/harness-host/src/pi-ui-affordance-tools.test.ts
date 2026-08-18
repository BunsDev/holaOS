import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const piSource = fs.readFileSync(path.join(__dirname, "pi.ts"), "utf8");

/** The DEFERRABLE_ADMIN_TOOLS map body. */
function deferrableAdminBlock(): string {
  const start = piSource.indexOf("const DEFERRABLE_ADMIN_TOOLS");
  assert.ok(start > 0, "DEFERRABLE_ADMIN_TOOLS should still exist");
  const end = piSource.indexOf("};", start);
  return piSource.slice(start, end);
}

test("tools the interface depends on are not deferred", () => {
  // propose_connect's RESULT is what renders the Connect card on the canvas, and
  // it is the action at the end of the integration discovery chain:
  //   list_catalog (native) -> composio_search_tools (native) -> propose_connect
  //
  // Observed live with it deferred: no schema in the prompt, so the model called
  // it without the required toolkit_slug, got "toolkit_slug is required", and
  // retried — a wasted round trip on exactly the interactive turn where the user
  // is watching. The sibling comment in pi.ts records the same lesson for
  // composio_search_tools; this is one step further along the same chain.
  //
  // The schema is cheap: the whole admin group is ~4.1k tokens across ten tools,
  // against composio's ~25.7k. There is no budget argument for deferring it.
  assert.doesNotMatch(
    deferrableAdminBlock(),
    /holaboss_workspace_integrations_propose_connect/,
    "propose_connect drives a canvas card and must stay in the prompt",
  );
});

test("the genuinely rare admin tools are still deferred", () => {
  // The elevation above must not be read as "stop deferring admin tools". These
  // really do essentially never fire on a normal turn, and they are what buys
  // the ~4.1k tokens back.
  const block = deferrableAdminBlock();
  for (const name of [
    "mcp_connect",
    "mcp_refresh",
    "mcp_reauthorize",
    "capability_install",
    "open_macos_settings",
    "update_workspace_instructions",
  ]) {
    assert.match(block, new RegExp(name), `${name} should stay deferred`);
  }
});

test("the discovery path stays native", () => {
  // Regression the codebase already paid for once: gating composio_search_tools
  // cost a real turn to "Tool not found" plus two rediscovery steps.
  const block = deferrableAdminBlock();
  for (const name of [
    "workspace_integrations_list_catalog",
    "composio_search_tools",
    "composio_execute_tool",
  ]) {
    assert.doesNotMatch(block, new RegExp(`\\b${name}\\b`), `${name} must stay native`);
  }
});
