import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveToolName } from "./toolNames.js";

/**
 * Regression: a Connect card never rendered because the model reached the tool
 * through a generic dispatch wrapper. Taken from a real turn — the agent asked
 * to connect Notion, the backend returned the proposal, and the card silently
 * did not appear because the parser compared the WRAPPER's name against the
 * tool it was looking for.
 */

test("a directly-named tool keeps its name", () => {
  assert.equal(
    effectiveToolName({ tool_name: "composio_search_tools" }),
    "composio_search_tools",
  );
});

test("an mcp-prefixed name is still reduced to the bare tool", () => {
  assert.equal(
    effectiveToolName({ tool_name: "mcp__holaboss__workspace_memory_write" }),
    "workspace_memory_write",
  );
});

test("a call_tool wrapper resolves to the tool it dispatched", () => {
  // Verbatim shape from the failing turn.
  assert.equal(
    effectiveToolName({
      phase: "completed",
      tool_name: "call_tool",
      tool_args: {
        name: "holaboss_workspace_integrations_propose_connect",
        arguments: { provider_id: "notion", toolkit_slug: "notion" },
      },
      error: false,
    }),
    "holaboss_workspace_integrations_propose_connect",
  );
});

test("a wrapper around an mcp-prefixed tool reduces both layers", () => {
  assert.equal(
    effectiveToolName({
      tool_name: "call_tool",
      tool_args: { name: "mcp__holaboss__some_tool" },
    }),
    "some_tool",
  );
});

test("an unresolvable wrapper keeps its own name rather than going blank", () => {
  // "" would be dangerous: a parser testing `toolName !== X` could be fooled by
  // an empty string matching some other guard, so a malformed event stays
  // recognisably a wrapper.
  assert.equal(effectiveToolName({ tool_name: "call_tool" }), "call_tool");
  assert.equal(
    effectiveToolName({ tool_name: "call_tool", tool_args: { name: 42 } }),
    "call_tool",
  );
  assert.equal(
    effectiveToolName({ tool_name: "call_tool", tool_args: "nonsense" }),
    "call_tool",
  );
});

test("a missing tool_name does not throw", () => {
  assert.equal(effectiveToolName({}), "");
  assert.equal(effectiveToolName({ tool_name: 7 }), "");
});
