/**
 * MCP tool proxy — lazy, catalog-driven access to MCP tools through a single
 * always-active gateway tool, instead of inlining every MCP tool's schema.
 *
 * Why: pi puts every registered tool's full JSON schema into the model-facing
 * prompt on every turn. A production workspace with heavy MCP servers measured
 * 186 tools ≈ 54k tokens (an AdsPower browser tool's schema alone is ~4k), and
 * every cold (new-chat) turn cold-prefills all of it — the dominant TTFT cost.
 *
 * Alone, register-but-deactivate + an `activate_tools` tool (pi's
 * setActiveToolsByName) failed in practice: after activating, weaker models
 * (deepseek/GLM) call the tool by a SHORTENED name typed from the text catalog
 * (`list_profiles` instead of `mcp__holapool__list_profiles`) → "tool not found"
 * → they flail. A native tool is only reliably callable when it's a real entry
 * in the model's tool list; from a text catalog, names get mangled.
 *
 * So the model calls ONE always-present gateway instead:
 *   mcp_call({ name, arguments })   — invoke any MCP tool; name is a STRING arg
 *   mcp_describe({ name })          — fetch a tool's arg schema on demand
 * The name is a forgiving string argument (not a native tool name), so the proxy
 * FUZZY-resolves `list_profiles`, `mcp__holapool__list_profiles`, or a guessed
 * `holapool_list_profiles` to the same tool. No activation, no mid-turn timing
 * dependency, no exact-name requirement. Calls route straight to the existing
 * mcporter runtime via each MCP tool's own execute, reusing all the existing
 * discovery / OAuth / scoping / result handling.
 *
 * This does NOT replace pi's active-tool control — it layers on top of it. The
 * MCP tools stay REGISTERED (so they can be promoted), just inactive by default;
 * when the model actually calls one through `mcp_call`, the proxy PROMOTES it to
 * the active set (setActiveToolsByName) so subsequent turns can call it natively
 * with its real schema. The proxy is the robust always-available path; promotion
 * upgrades hot tools to native. The long tail stays out of the prompt.
 *
 * Default ON past HB_MCP_TOOL_DISCLOSURE_MIN tools (so small workspaces keep
 * every MCP tool native); set HB_MCP_TOOL_DISCLOSURE=0 to force fully-native.
 */

export const MCP_CALL_TOOL_NAME = "mcp_call";
export const MCP_DESCRIBE_TOOL_NAME = "mcp_describe";

const DEFAULT_MCP_PROXY_MIN_TOOLS = 24;

/** Minimal slice of AgentSession the proxy uses to promote tools to native. */
export interface ActiveToolController {
  getAllTools(): ReadonlyArray<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

/** The pi ToolDefinition execute shape we forward to (5 args). */
type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<unknown>;

/** One MCP tool the proxy can route to. `execute` is the tool's own execute. */
export interface McpProxyTarget {
  name: string;
  description?: string;
  parameters?: unknown;
  serverId?: string;
  toolName?: string;
  execute: ToolExecute;
}

/** A pi ToolDefinition-compatible object (typed loosely; cast at the call site). */
export interface ProxyToolDefinition {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: ToolExecute;
}

export interface McpToolProxy {
  /** The gateway tools to register (always active). */
  proxyTools: ProxyToolDefinition[];
  /** MCP tool names to keep OUT of the session's customTools (routed via proxy). */
  gatedNames: Set<string>;
}

export function mcpToolProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default ON (past the tool-count threshold). Set HB_MCP_TOOL_DISCLOSURE=0 to
  // force MCP tools fully native (the pre-proxy behavior).
  const value = (env.HB_MCP_TOOL_DISCLOSURE ?? "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function mcpToolProxyMinTools(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.HB_MCP_TOOL_DISCLOSURE_MIN ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_PROXY_MIN_TOOLS;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function firstLine(text: string | undefined, max = 160): string {
  const line =
    (text ?? "")
      .split("\n")
      .map((segment) => segment.trim())
      .find((segment) => segment.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function buildMcpToolCatalog(
  targets: ReadonlyArray<Pick<McpProxyTarget, "name" | "description">>,
): string[] {
  return targets.map((target) => {
    const desc = firstLine(target.description);
    return desc ? `- ${target.name} — ${desc}` : `- ${target.name}`;
  });
}

type Resolution =
  | { kind: "found"; target: McpProxyTarget }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Build a forgiving name→target resolver over the given MCP tools. */
export function createMcpNameResolver(
  targets: ReadonlyArray<McpProxyTarget>,
): (requested: string) => Resolution {
  const byExact = new Map<string, McpProxyTarget>();
  const byKey = new Map<string, McpProxyTarget[]>();
  const addKey = (key: string, target: McpProxyTarget): void => {
    if (!key) return;
    const bucket = byKey.get(key) ?? [];
    bucket.push(target);
    byKey.set(key, bucket);
  };
  for (const target of targets) {
    byExact.set(target.name.toLowerCase(), target);
    addKey(normalizeName(target.name), target);
    if (target.toolName) addKey(normalizeName(target.toolName), target);
    if (target.serverId && target.toolName) {
      addKey(normalizeName(`${target.serverId}_${target.toolName}`), target);
    }
  }
  const dedupeNames = (list: McpProxyTarget[]): string[] => [
    ...new Set(list.map((t) => t.name)),
  ];
  return (requested: string): Resolution => {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) return { kind: "none" };
    const exact = byExact.get(trimmed.toLowerCase());
    if (exact) return { kind: "found", target: exact };
    const key = normalizeName(trimmed);
    const keyed = byKey.get(key);
    if (keyed && keyed.length === 1) return { kind: "found", target: keyed[0] };
    if (keyed && keyed.length > 1) {
      return { kind: "ambiguous", candidates: dedupeNames(keyed) };
    }
    // Suffix fallback: `mcp__holapool__list_profiles` requested for a target
    // whose bare name is `list_profiles`, or vice-versa.
    const suffix = targets.filter(
      (t) => t.toolName && key.endsWith(normalizeName(t.toolName)),
    );
    if (suffix.length === 1) return { kind: "found", target: suffix[0] };
    if (suffix.length > 1) return { kind: "ambiguous", candidates: dedupeNames(suffix) };
    return { kind: "none" };
  };
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

function readStringField(params: unknown, field: string): string {
  if (params && typeof params === "object") {
    const value = (params as Record<string, unknown>)[field];
    if (typeof value === "string") return value.trim();
  }
  return "";
}

/**
 * Promote a resolved MCP tool into the session's ACTIVE set so subsequent turns
 * can call it natively (with its real schema). Best-effort: the proxy call itself
 * works regardless, so any failure here is non-fatal.
 */
function promoteToNative(
  controller: ActiveToolController | null,
  name: string,
): void {
  if (!controller) return;
  try {
    const active = controller.getActiveToolNames();
    if (active.includes(name)) return;
    if (!controller.getAllTools().some((tool) => tool.name === name)) return;
    controller.setActiveToolsByName([...new Set([...active, name])]);
  } catch {
    /* non-fatal: the direct proxy call below still runs */
  }
}

/**
 * Build the proxy over the given MCP tools, or return null when disabled or under
 * the tool-count threshold (in which case the caller keeps MCP tools native).
 */
export function buildMcpToolProxy(params: {
  targets: ReadonlyArray<McpProxyTarget>;
  sessionRef: { current: ActiveToolController | null };
  env?: NodeJS.ProcessEnv;
}): McpToolProxy | null {
  const env = params.env ?? process.env;
  if (!mcpToolProxyEnabled(env)) return null;
  const targets = params.targets.filter((target) => target.name);
  if (targets.length < mcpToolProxyMinTools(env)) return null;

  const { sessionRef } = params;
  const resolve = createMcpNameResolver(targets);
  const catalog = buildMcpToolCatalog(targets);
  const gatedNames = new Set(targets.map((target) => target.name));

  const mcpCall: ProxyToolDefinition = {
    name: MCP_CALL_TOOL_NAME,
    label: "MCP call",
    description:
      "Call any connected MCP/integration tool. Pass its `name` (from the tool catalog in your " +
      "guidelines) and its `arguments`. Use `mcp_describe` first if you are unsure of a tool's arguments. " +
      "The name is matched leniently, but prefer the exact catalog name.",
    promptGuidelines: [
      `Connected MCP/integration tools are called through \`${MCP_CALL_TOOL_NAME}\`, not directly: ` +
        `\`${MCP_CALL_TOOL_NAME}({ name: "<exact catalog name>", arguments: { ... } })\`. ` +
        `Call \`${MCP_DESCRIBE_TOOL_NAME}({ name })\` first when you need a tool's argument schema.`,
      "MCP tool catalog (exact name — what it does):",
      ...catalog,
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: "Exact tool name from the catalog (e.g. mcp__server__tool).",
        },
        arguments: {
          type: "object",
          description:
            "Arguments for the tool. Use mcp_describe to see the tool's schema.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
    execute: async (toolCallId, callParams, signal, onUpdate, ctx) => {
      const name = readStringField(callParams, "name");
      if (!name) {
        return textResult(`${MCP_CALL_TOOL_NAME} requires a \`name\` from the tool catalog.`);
      }
      const resolution = resolve(name);
      if (resolution.kind === "ambiguous") {
        return textResult(
          `"${name}" matches multiple tools — call it by its exact name: ${resolution.candidates.join(", ")}.`,
        );
      }
      if (resolution.kind === "none") {
        return textResult(
          `No MCP tool matches "${name}". Use an exact name from the catalog (see your guidelines).`,
        );
      }
      const { target } = resolution;
      // Promote this tool to the active set so later turns can call it natively
      // with its real schema; the direct call below runs either way.
      promoteToNative(sessionRef.current, target.name);
      const args =
        callParams && typeof callParams === "object"
          ? (callParams as { arguments?: unknown }).arguments ?? {}
          : {};
      return await target.execute(toolCallId, args, signal, onUpdate, ctx);
    },
  };

  const mcpDescribe: ProxyToolDefinition = {
    name: MCP_DESCRIBE_TOOL_NAME,
    label: "MCP describe",
    description:
      "Return the argument schema and description for a connected MCP/integration tool by name, " +
      "so you can call it correctly via mcp_call.",
    promptGuidelines: [],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: "Exact tool name from the catalog to describe.",
        },
      },
      required: ["name"],
    },
    execute: async (_toolCallId, describeParams) => {
      const name = readStringField(describeParams, "name");
      const resolution = resolve(name);
      if (resolution.kind === "ambiguous") {
        return textResult(
          `"${name}" matches multiple tools: ${resolution.candidates.join(", ")}. Describe one by its exact name.`,
        );
      }
      if (resolution.kind === "none") {
        return textResult(`No MCP tool matches "${name}".`);
      }
      const { target } = resolution;
      return textResult(
        JSON.stringify(
          {
            name: target.name,
            description: target.description ?? "",
            parameters: target.parameters ?? {},
          },
          null,
          2,
        ),
      );
    },
  };

  return { proxyTools: [mcpCall, mcpDescribe], gatedNames };
}
