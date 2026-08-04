// Collapse a family of sibling runtime tools (e.g. cronjobs_create, cronjobs_list,
// cronjobs_delete, …) into ONE tool that dispatches on an `op` field, so the model's
// request carries a single schema instead of N. Purely a presentation-layer change:
// the underlying capability tools keep their real handlers — the consolidated tool
// just routes `op` back to the matching original handler. The capability system,
// runtime routing, ids, and manifest are all untouched; this only shrinks the
// per-turn tool payload the model has to prefill.

type ConsolidatableTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: any[]) => any;
};

function compactFirstSentence(text: string, max = 200): string {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const end = normalized.indexOf(". ");
  const head =
    end > 0 && end + 1 <= max
      ? normalized.slice(0, end + 1)
      : normalized.slice(0, max);
  return head.trim();
}

export interface ToolFamilySpec {
  /** Consolidated tool name, e.g. "cronjobs". */
  name: string;
  /** Return the `op` for a member tool given its name, or null if not a member. */
  opOf: (toolName: string) => string | null;
  /** Family-level description + any critical guidance worth stating once. */
  preamble: string;
}

function consolidateOne<T extends ConsolidatableTool>(
  tools: T[],
  spec: ToolFamilySpec,
): T[] {
  const members: Array<{ op: string; tool: T }> = [];
  const rest: T[] = [];
  for (const tool of tools) {
    const op = spec.opOf(tool.name);
    if (op) {
      members.push({ op, tool });
    } else {
      rest.push(tool);
    }
  }
  // Nothing to gain from wrapping a single member (or none).
  if (members.length < 2) {
    return tools;
  }
  const byOp = new Map(members.map((m) => [m.op, m.tool]));
  // Merged params: the union of every member's properties (first definition wins),
  // all optional; only `op` is required. Which fields apply to which op is spelled
  // out in the description below.
  const properties: Record<string, unknown> = {
    op: {
      type: "string",
      enum: [...byOp.keys()],
      description:
        "Which operation to run. See the operation list in this tool's description for the fields each op uses.",
    },
  };
  const opDocs: string[] = [];
  for (const { op, tool } of members) {
    const params = (tool.parameters ?? {}) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [key, schema] of Object.entries(params.properties ?? {})) {
      if (!(key in properties)) {
        properties[key] = schema;
      }
    }
    const needs = params.required ?? [];
    opDocs.push(
      `- \`${op}\`${needs.length ? ` (fields: ${needs.join(", ")})` : ""} — ${compactFirstSentence(String(tool.description ?? ""))}`,
    );
  }
  const consolidated = {
    ...members[0].tool,
    name: spec.name,
    description: `${spec.preamble}\n\nSet \`op\` to one of:\n${opDocs.join("\n")}`,
    parameters: { type: "object", properties, required: ["op"] },
    execute: async (...args: any[]): Promise<unknown> => {
      // pi execute signature: (toolCallId, toolParams, signal).
      const [toolCallId, toolParams, signal] = args;
      const params = (toolParams ?? {}) as Record<string, unknown>;
      const op = String(params.op ?? "");
      const target = byOp.get(op);
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown op "${op}" for ${spec.name}. Valid ops: ${[...byOp.keys()].join(", ")}.`,
            },
          ],
          is_error: true,
        };
      }
      const { op: _dropped, ...forwarded } = params;
      return target.execute(toolCallId, forwarded, signal);
    },
  } as T;
  return [...rest, consolidated];
}

/**
 * Consolidate the `cronjobs_*` and `terminal_session(s)_*` families into one tool
 * each. Safe no-op for any family with fewer than two members present.
 */
export function consolidateRuntimeToolFamilies<T extends ConsolidatableTool>(
  tools: T[],
): T[] {
  let out = tools;
  out = consolidateOne(out, {
    name: "cronjobs",
    opOf: (name) =>
      name.startsWith("cronjobs_") ? name.slice("cronjobs_".length) : null,
    preamble:
      "Manage scheduled cronjobs — recurring subagent runs — for this workspace. " +
      "TIMEZONE: the `cron` you pass is evaluated in the USER'S timezone, not UTC; " +
      "write the hour as their local wall-clock time (e.g. 10 AM → `0 10 * * *`). " +
      "The response echoes `runs_in_timezone` and `next_run_local` — report those to " +
      "the user and never convert the cron hour yourself.",
  });
  out = consolidateOne(out, {
    name: "terminal_session",
    opOf: (name) =>
      /^terminal_sessions?_/.test(name)
        ? name.replace(/^terminal_sessions?_/, "")
        : null,
    preamble:
      "Manage background terminal sessions: start a long-running command, then read " +
      "output, wait for completion, send input, signal, inspect, close, or list sessions.",
  });
  return out;
}
