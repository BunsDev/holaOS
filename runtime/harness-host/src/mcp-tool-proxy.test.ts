import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActiveToolController,
  buildMcpToolCatalog,
  buildMcpToolProxy,
  createMcpNameResolver,
  type McpProxyTarget,
  MCP_CALL_TOOL_NAME,
  MCP_DESCRIBE_TOOL_NAME,
} from "./mcp-tool-proxy.js";

const ON = { HB_MCP_TOOL_DISCLOSURE: "1" } as NodeJS.ProcessEnv;

function target(
  name: string,
  serverId: string,
  toolName: string,
  execute?: McpProxyTarget["execute"],
): McpProxyTarget {
  return {
    name,
    description: `Do ${toolName}`,
    parameters: { type: "object", properties: { x: { type: "string" } } },
    serverId,
    toolName,
    execute:
      execute ??
      (async () => ({ content: [{ type: "text", text: `ran ${name}` }] })),
  };
}

function manyTargets(n: number): McpProxyTarget[] {
  return Array.from({ length: n }, (_, i) =>
    target(`mcp__srv__tool_${i}`, "srv", `tool_${i}`),
  );
}

test("resolver: exact, bare, server_tool, and mcp__ forms all resolve", () => {
  const t = target("mcp__holapool__list_profiles", "holapool", "list_profiles");
  const resolve = createMcpNameResolver([t]);
  for (const spelling of [
    "mcp__holapool__list_profiles",
    "list_profiles",
    "holapool_list_profiles",
    "MCP__HOLAPOOL__LIST_PROFILES",
    "mcp__holapool__list-profiles",
  ]) {
    const r = resolve(spelling);
    assert.equal(r.kind, "found", `"${spelling}" should resolve`);
    if (r.kind === "found") assert.equal(r.target.name, t.name);
  }
  assert.equal(resolve("nope").kind, "none");
});

test("resolver: bare name shared by two servers is ambiguous", () => {
  const resolve = createMcpNameResolver([
    target("mcp__a__list", "a", "list"),
    target("mcp__b__list", "b", "list"),
  ]);
  const r = resolve("list");
  assert.equal(r.kind, "ambiguous");
  if (r.kind === "ambiguous") {
    assert.deepEqual(new Set(r.candidates), new Set(["mcp__a__list", "mcp__b__list"]));
  }
  // exact full names are still unambiguous
  assert.equal(resolve("mcp__a__list").kind, "found");
});

test("catalog: `- name — first line`", () => {
  const c = buildMcpToolCatalog([{ name: "x", description: "Line1\nLine2" }, { name: "y" }]);
  assert.equal(c[0], "- x — Line1");
  assert.equal(c[1], "- y");
});

test("proxy is ON by default (past threshold), off under threshold, and force-off via env=0", () => {
  // default on (no env) past the threshold
  assert.ok(
    buildMcpToolProxy({ targets: manyTargets(50), sessionRef: { current: null }, env: {} as NodeJS.ProcessEnv }),
  );
  // under threshold → null even when on
  assert.equal(
    buildMcpToolProxy({ targets: manyTargets(5), sessionRef: { current: null }, env: ON }),
    null,
  );
  // explicit force-off
  assert.equal(
    buildMcpToolProxy({
      targets: manyTargets(50),
      sessionRef: { current: null },
      env: { HB_MCP_TOOL_DISCLOSURE: "0" } as NodeJS.ProcessEnv,
    }),
    null,
  );
});

test("enabled + past threshold: emits mcp_call + mcp_describe, gates all MCP names, catalog in guidelines", () => {
  const proxy = buildMcpToolProxy({ targets: manyTargets(30), sessionRef: { current: null }, env: ON });
  assert.ok(proxy);
  assert.deepEqual(
    proxy.proxyTools.map((t) => t.name),
    [MCP_CALL_TOOL_NAME, MCP_DESCRIBE_TOOL_NAME],
  );
  assert.equal(proxy.gatedNames.size, 30);
  const call = proxy.proxyTools[0];
  assert.ok(call.promptGuidelines.some((line) => line.includes("mcp__srv__tool_0")));
});

test("mcp_call: fuzzy-resolves, forwards arguments, routes to target.execute, and PROMOTES to native", async () => {
  const calls: Array<{ id: string; args: unknown }> = [];
  const tools = [
    ...manyTargets(29),
    target("mcp__holapool__list_profiles", "holapool", "list_profiles", async (id, args) => {
      calls.push({ id, args });
      return { content: [{ type: "text", text: "PROFILES" }] };
    }),
  ];
  const setActive: string[][] = [];
  const controller: ActiveToolController = {
    getAllTools: () => tools.map((t) => ({ name: t.name })),
    getActiveToolNames: () => ["mcp_call", "bash"],
    setActiveToolsByName: (names) => setActive.push(names),
  };
  const proxy = buildMcpToolProxy({ targets: tools, sessionRef: { current: controller }, env: ON });
  assert.ok(proxy);
  const mcpCall = proxy.proxyTools[0];

  // model calls it by the SHORTENED name — the thing that broke the native flow
  const out: any = await mcpCall.execute(
    "call-1",
    { name: "list_profiles", arguments: { limit: 5 } },
    undefined,
    undefined,
    undefined,
  );

  assert.equal(calls.length, 1, "routed to the target's execute");
  assert.deepEqual(calls[0].args, { limit: 5 }, "forwarded the arguments verbatim");
  assert.equal(out.content[0].text, "PROFILES");
  // promoted the resolved (full) name to the active set, additively
  assert.equal(setActive.length, 1);
  assert.ok(setActive[0].includes("mcp__holapool__list_profiles"));
  assert.ok(setActive[0].includes("mcp_call"));
});

test("mcp_call: ambiguous + unknown names return guidance, not a throw", async () => {
  const tools = [
    ...manyTargets(28),
    target("mcp__a__list", "a", "list"),
    target("mcp__b__list", "b", "list"),
  ];
  const proxy = buildMcpToolProxy({ targets: tools, sessionRef: { current: null }, env: ON });
  assert.ok(proxy);
  const mcpCall = proxy.proxyTools[0];

  const amb: any = await mcpCall.execute("c", { name: "list" }, undefined, undefined, undefined);
  assert.ok(amb.content[0].text.includes("mcp__a__list"));
  assert.ok(amb.content[0].text.toLowerCase().includes("multiple"));

  const none: any = await mcpCall.execute("c", { name: "ghost" }, undefined, undefined, undefined);
  assert.ok(none.content[0].text.toLowerCase().includes("no mcp tool"));
});

test("mcp_describe: returns the tool's schema + description", async () => {
  const tools = [
    ...manyTargets(29),
    target("mcp__holapool__list_profiles", "holapool", "list_profiles"),
  ];
  const proxy = buildMcpToolProxy({ targets: tools, sessionRef: { current: null }, env: ON });
  assert.ok(proxy);
  const describe = proxy.proxyTools[1];
  const out: any = await describe.execute("c", { name: "list_profiles" }, undefined, undefined, undefined);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.name, "mcp__holapool__list_profiles");
  assert.equal(parsed.description, "Do list_profiles");
  assert.ok(parsed.parameters.properties.x);
});
