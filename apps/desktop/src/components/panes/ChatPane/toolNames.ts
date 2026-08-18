/**
 * Resolving which tool a `tool_call` event is actually about.
 *
 * Kept apart from the pane so it can be tested without loading the React tree.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strip an `mcp__<server>__` prefix down to the bare tool name. */
export function bareRuntimeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.startsWith("mcp__")) return trimmed;
  const afterPrefix = trimmed.slice("mcp__".length);
  const separator = afterPrefix.indexOf("__");
  return separator === -1 ? afterPrefix : afterPrefix.slice(separator + 2);
}

/**
 * The tool a `tool_call` event is actually about.
 *
 * A model can reach a runtime tool two ways: named directly
 * (`tool_name: "composio_search_tools"`) or dispatched through a generic
 * wrapper (`tool_name: "call_tool"`, real name at `tool_args.name`). Every
 * card parser below keys off the tool name, and they all read `tool_name`
 * directly — so on a wrapped call they compare against "call_tool", bail, and
 * the card silently never renders.
 *
 * Observed live: the agent proposed a Notion connection via
 * `call_tool -> holaboss_workspace_integrations_propose_connect`, the backend
 * returned the proposal, and no Connect card appeared. The turn text said one
 * had been put up, because from the model's side it had. Four card types share
 * this parser shape, so all four fail identically.
 */
const TOOL_DISPATCH_WRAPPERS: ReadonlySet<string> = new Set(["call_tool"]);

export function effectiveToolName(payload: Record<string, unknown>): string {
  const raw = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const bare = bareRuntimeToolName(raw);
  if (!TOOL_DISPATCH_WRAPPERS.has(bare)) {
    return bare;
  }
  const args = payload.tool_args;
  const inner =
    isRecord(args) && typeof args.name === "string" ? args.name : "";
  // An unresolvable wrapper keeps its own name rather than becoming "", so a
  // malformed event cannot accidentally match a parser looking for a bare name.
  return inner ? bareRuntimeToolName(inner) : bare;
}
