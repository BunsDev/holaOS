/**
 * Deferred tool gateway — keeps bulky, occasionally-used tool families OUT of the
 * per-turn prompt and reaches them through one small always-present gateway.
 *
 * Why: pi puts every ACTIVE tool's full JSON schema into the model-facing prompt
 * on every turn. Measured on a real desktop workspace, a bare "hi" carried 131
 * tools = 185,163 chars (~46k tokens) of schemas, versus a 37.7k-char system
 * prompt. The breakdown:
 *
 *   Composio connected integrations  66 tools  ~25,700 tok  (github, airtable,
 *                                                            twitter, gmail …)
 *   Browser tool family              33 tools   ~9,600 tok
 *   MCP servers                       4 tools   ~1,400 tok
 *
 * Every one of those rode in every turn regardless of the message, and on a cold
 * (new-chat) turn the provider prefills all of it — the dominant TTFT cost.
 *
 * Design: the tools stay REGISTERED (so they can be promoted) but INACTIVE, so
 * their schemas cost nothing. The model sees a compact catalogue of tool NAMES
 * grouped by family — carried in this gateway's tool `description`, because pi's
 * `buildSystemPrompt` takes an early return on the `customPrompt` path (which
 * holaOS always uses) and never emits `promptGuidelines`; anything put there is
 * silently dropped. Names are self-describing (`github_create_a_commit`), so the
 * catalogue costs a few hundred tokens instead of tens of thousands.
 *
 * Reaching a deferred tool:
 *   describe_tool({ name })          → its full argument schema, on demand
 *   call_tool({ name, arguments })   → invoke it now, via fuzzy name resolution
 *
 * `call_tool` is the robust path: the name is a forgiving STRING argument, so a
 * model that shortens or mis-spells (`list_profiles` for
 * `mcp__holapool__list_profiles`) still resolves. Calls route through each tool's
 * own execute, so existing discovery / OAuth / scoping / output-caps all apply.
 *
 * On first use of any tool in a family, the WHOLE family is promoted into pi's
 * active set (`setActiveToolsByName`), so subsequent turns call those tools
 * natively with their real schemas — you pay the gateway only until a family is
 * actually needed. Browser work in particular is multi-step, so promoting the
 * family (not the single tool) is what keeps it ergonomic.
 *
 * Default ON past HB_DEFERRED_TOOLS_MIN tools (small workspaces keep everything
 * native); HB_DEFERRED_TOOLS=0 forces the pre-gateway behavior.
 */

export const CALL_TOOL_NAME = "call_tool";
export const DESCRIBE_TOOL_NAME = "describe_tool";

const DEFAULT_DEFERRED_MIN_TOOLS = 24;

/** The pi ToolDefinition execute shape we forward to. */
type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<unknown>;

/** Minimal slice of AgentSession used to promote a family to native. */
export interface ActiveToolController {
  getAllTools(): ReadonlyArray<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

/** One deferrable tool, tagged with the family it belongs to. */
export interface DeferredToolTarget {
  name: string;
  /** Family label used for the catalogue and for group promotion. */
  group: string;
  description?: string;
  parameters?: unknown;
  /** Alternate spelling (e.g. an MCP tool's bare name) for fuzzy resolution. */
  bareName?: string;
  execute: ToolExecute;
}

/** A pi ToolDefinition-compatible object (typed loosely; cast at the call site). */
export interface GatewayToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: ToolExecute;
}

export interface DeferredToolGateway {
  /** Gateway tools to register (always active). */
  gatewayTools: GatewayToolDefinition[];
  /** Tool names to DEACTIVATE after session creation. */
  gatedNames: Set<string>;
}

export function deferredToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.HB_DEFERRED_TOOLS ?? "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function deferredToolsMinTools(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.HB_DEFERRED_TOOLS_MIN ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEFERRED_MIN_TOOLS;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** `group: name, name, …` lines — names only; they are self-describing. */
export function buildDeferredToolCatalog(
  targets: ReadonlyArray<Pick<DeferredToolTarget, "name" | "group">>,
): string[] {
  const byGroup = new Map<string, string[]>();
  for (const target of targets) {
    const bucket = byGroup.get(target.group) ?? [];
    bucket.push(target.name);
    byGroup.set(target.group, bucket);
  }
  return [...byGroup.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([group, names]) => `${group} (${names.length}): ${[...names].sort().join(", ")}`);
}

type Resolution =
  | { kind: "found"; target: DeferredToolTarget }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Forgiving name → target resolver (exact, normalized, bare, group-suffixed). */
export function createDeferredNameResolver(
  targets: ReadonlyArray<DeferredToolTarget>,
): (requested: string) => Resolution {
  const byExact = new Map<string, DeferredToolTarget>();
  const byKey = new Map<string, DeferredToolTarget[]>();
  const addKey = (key: string, target: DeferredToolTarget): void => {
    if (!key) return;
    const bucket = byKey.get(key) ?? [];
    bucket.push(target);
    byKey.set(key, bucket);
  };
  for (const target of targets) {
    byExact.set(target.name.toLowerCase(), target);
    addKey(normalizeName(target.name), target);
    if (target.bareName) addKey(normalizeName(target.bareName), target);
    addKey(normalizeName(`${target.group}_${target.bareName ?? target.name}`), target);
  }
  const names = (list: DeferredToolTarget[]): string[] => [...new Set(list.map((t) => t.name))];
  return (requested: string): Resolution => {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) return { kind: "none" };
    const exact = byExact.get(trimmed.toLowerCase());
    if (exact) return { kind: "found", target: exact };
    const key = normalizeName(trimmed);
    const keyed = byKey.get(key);
    if (keyed?.length === 1) return { kind: "found", target: keyed[0] };
    if (keyed && keyed.length > 1) return { kind: "ambiguous", candidates: names(keyed) };
    const suffix = targets.filter((t) =>
      key.endsWith(normalizeName(t.bareName ?? t.name)),
    );
    if (suffix.length === 1) return { kind: "found", target: suffix[0] };
    if (suffix.length > 1) return { kind: "ambiguous", candidates: names(suffix) };
    return { kind: "none" };
  };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
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
 * Promote every tool in the resolved tool's family into the active set, so later
 * turns call them natively. Best-effort: the gateway call itself works regardless.
 */
function promoteGroupToNative(
  controller: ActiveToolController | null,
  targets: ReadonlyArray<DeferredToolTarget>,
  group: string,
): string[] {
  if (!controller) return [];
  try {
    const registered = new Set(controller.getAllTools().map((tool) => tool.name));
    const familyNames = targets
      .filter((target) => target.group === group && registered.has(target.name))
      .map((target) => target.name);
    if (familyNames.length === 0) return [];
    const active = controller.getActiveToolNames();
    const next = [...new Set([...active, ...familyNames])];
    if (next.length !== active.length) controller.setActiveToolsByName(next);
    return familyNames;
  } catch {
    return [];
  }
}

/**
 * Build the gateway over the given deferrable tools, or return null when disabled
 * or under the threshold (caller then keeps every tool native).
 */
export function buildDeferredToolGateway(params: {
  targets: ReadonlyArray<DeferredToolTarget>;
  sessionRef: { current: ActiveToolController | null };
  env?: NodeJS.ProcessEnv;
}): DeferredToolGateway | null {
  const env = params.env ?? process.env;
  if (!deferredToolsEnabled(env)) return null;
  const targets = params.targets.filter((target) => target.name && target.group);
  if (targets.length < deferredToolsMinTools(env)) return null;

  const { sessionRef } = params;
  const resolve = createDeferredNameResolver(targets);
  const catalog = buildDeferredToolCatalog(targets);
  const gatedNames = new Set(targets.map((target) => target.name));

  const callTool: GatewayToolDefinition = {
    name: CALL_TOOL_NAME,
    label: "Call tool",
    description:
      `Call any of the workspace's integration, browser, or MCP tools listed below. ` +
      `Pass the tool's \`name\` and its \`arguments\`. Use \`${DESCRIBE_TOOL_NAME}\` first when you ` +
      `need a tool's argument schema. These tools are not loaded individually to keep the ` +
      `context small; the first call to a family loads the rest of that family for later turns.\n\n` +
      `Available tools by family:\n${catalog.join("\n")}`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Exact tool name from the list in this description." },
        arguments: {
          type: "object",
          description: `Arguments for the tool. Use ${DESCRIBE_TOOL_NAME} to see its schema.`,
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
    execute: async (toolCallId, callParams, signal, onUpdate, ctx) => {
      const name = readStringField(callParams, "name");
      if (!name) return textResult(`${CALL_TOOL_NAME} requires a \`name\`.`);
      const resolution = resolve(name);
      if (resolution.kind === "ambiguous") {
        return textResult(
          `"${name}" matches multiple tools — use an exact name: ${resolution.candidates.join(", ")}.`,
        );
      }
      if (resolution.kind === "none") {
        return textResult(`No tool matches "${name}". Use an exact name from the ${CALL_TOOL_NAME} list.`);
      }
      const { target } = resolution;
      promoteGroupToNative(sessionRef.current, targets, target.group);
      const args =
        callParams && typeof callParams === "object"
          ? (callParams as { arguments?: unknown }).arguments ?? {}
          : {};
      return await target.execute(toolCallId, args, signal, onUpdate, ctx);
    },
  };

  const describeTool: GatewayToolDefinition = {
    name: DESCRIBE_TOOL_NAME,
    label: "Describe tool",
    description:
      `Return the description and argument schema for one of the tools listed in ` +
      `\`${CALL_TOOL_NAME}\`, so you can call it correctly.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Exact tool name to describe." },
      },
      required: ["name"],
    },
    execute: async (_toolCallId, describeParams) => {
      const name = readStringField(describeParams, "name");
      const resolution = resolve(name);
      if (resolution.kind === "ambiguous") {
        return textResult(
          `"${name}" matches multiple tools: ${resolution.candidates.join(", ")}. Describe one exactly.`,
        );
      }
      if (resolution.kind === "none") return textResult(`No tool matches "${name}".`);
      const { target } = resolution;
      return textResult(
        JSON.stringify(
          {
            name: target.name,
            group: target.group,
            description: target.description ?? "",
            parameters: target.parameters ?? {},
          },
          null,
          2,
        ),
      );
    },
  };

  return { gatewayTools: [callTool, describeTool], gatedNames };
}
