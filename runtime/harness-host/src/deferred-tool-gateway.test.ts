import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActiveToolController,
  buildDeferredToolCatalog,
  buildDeferredToolGateway,
  CALL_TOOL_NAME,
  createDeferredNameResolver,
  type DeferredToolTarget,
  DESCRIBE_TOOL_NAME,
} from "./deferred-tool-gateway.js";

const ON = {} as NodeJS.ProcessEnv; // default is ON

function target(
  name: string,
  group: string,
  opts: { bareName?: string; execute?: DeferredToolTarget["execute"] } = {},
): DeferredToolTarget {
  return {
    name,
    group,
    description: `Do ${name}`,
    parameters: { type: "object", properties: { x: { type: "string" } } },
    ...(opts.bareName ? { bareName: opts.bareName } : {}),
    execute:
      opts.execute ??
      (async () => ({ content: [{ type: "text", text: `ran ${name}` }] })),
  };
}

/** A realistic mix: browser family + two composio toolkits + one MCP server. */
function realisticTargets(): DeferredToolTarget[] {
  return [
    ...Array.from({ length: 20 }, (_, i) => target(`browser_act_${i}`, "browser")),
    ...Array.from({ length: 8 }, (_, i) => target(`github_action_${i}`, "github")),
    ...Array.from({ length: 6 }, (_, i) => target(`gmail_action_${i}`, "gmail")),
    target("mcp__holapool__list_profiles", "holapool", { bareName: "list_profiles" }),
  ];
}

test("catalog groups by family and lists names only (cheap discovery)", () => {
  const lines = buildDeferredToolCatalog([
    { name: "browser_click", group: "browser" },
    { name: "browser_act", group: "browser" },
    { name: "github_commit", group: "github" },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "browser (2): browser_act, browser_click");
  assert.equal(lines[1], "github (1): github_commit");
});

test("resolver handles exact, bare, group-prefixed and mangled spellings", () => {
  const resolve = createDeferredNameResolver([
    target("mcp__holapool__list_profiles", "holapool", { bareName: "list_profiles" }),
    target("github_create_a_commit", "github"),
  ]);
  for (const spelling of [
    "mcp__holapool__list_profiles",
    "list_profiles",
    "holapool_list_profiles",
    "MCP__HOLAPOOL__LIST_PROFILES",
  ]) {
    const r = resolve(spelling);
    assert.equal(r.kind, "found", `${spelling} should resolve`);
    if (r.kind === "found") assert.equal(r.target.name, "mcp__holapool__list_profiles");
  }
  const g = resolve("github_create_a_commit");
  assert.equal(g.kind, "found");
  assert.equal(resolve("totally_unknown").kind, "none");
});

test("gateway is ON by default past threshold, off under it, force-off via env", () => {
  assert.ok(
    buildDeferredToolGateway({ targets: realisticTargets(), sessionRef: { current: null }, env: ON }),
  );
  assert.equal(
    buildDeferredToolGateway({
      targets: [target("browser_act", "browser")],
      sessionRef: { current: null },
      env: ON,
    }),
    null,
  );
  assert.equal(
    buildDeferredToolGateway({
      targets: realisticTargets(),
      sessionRef: { current: null },
      env: { HB_DEFERRED_TOOLS: "0" } as NodeJS.ProcessEnv,
    }),
    null,
  );
});

test("gateway emits call_tool + describe_tool, gates every target, and carries the catalog in the DESCRIPTION", () => {
  const targets = realisticTargets();
  const gw = buildDeferredToolGateway({ targets, sessionRef: { current: null }, env: ON });
  assert.ok(gw);
  assert.deepEqual(gw.gatewayTools.map((t) => t.name), [CALL_TOOL_NAME, DESCRIBE_TOOL_NAME]);
  assert.equal(gw.gatedNames.size, targets.length);
  // the catalog MUST ride in the description — promptGuidelines is dropped by
  // pi's customPrompt path, so anything put there never reaches the model.
  const desc = gw.gatewayTools[0].description;
  assert.ok(desc.includes("browser (20):"), "browser family listed");
  assert.ok(desc.includes("github (8):"), "github family listed");
  assert.ok(desc.includes("mcp__holapool__list_profiles"), "mcp tool listed");
});

test("call_tool routes to the target, forwards arguments, and promotes the WHOLE family", async () => {
  const seen: unknown[] = [];
  const targets = [
    ...realisticTargets().filter((t) => t.group !== "github"),
    ...Array.from({ length: 8 }, (_, i) =>
      target(`github_action_${i}`, "github", {
        execute: async (_id, args) => {
          seen.push(args);
          return { content: [{ type: "text", text: "COMMITTED" }] };
        },
      }),
    ),
  ];
  const setActive: string[][] = [];
  const controller: ActiveToolController = {
    getAllTools: () => targets.map((t) => ({ name: t.name })),
    getActiveToolNames: () => [CALL_TOOL_NAME, "bash"],
    setActiveToolsByName: (names) => setActive.push(names),
  };
  const gw = buildDeferredToolGateway({ targets, sessionRef: { current: controller }, env: ON });
  assert.ok(gw);

  const out: any = await gw.gatewayTools[0].execute(
    "call-1",
    { name: "github_action_3", arguments: { message: "hi" } },
    undefined,
    undefined,
    undefined,
  );

  assert.deepEqual(seen, [{ message: "hi" }], "arguments forwarded verbatim");
  assert.equal(out.content[0].text, "COMMITTED");
  assert.equal(setActive.length, 1, "promoted once");
  const promoted = setActive[0];
  // the entire github family is promoted, not just the one tool
  for (let i = 0; i < 8; i++) assert.ok(promoted.includes(`github_action_${i}`));
  // other families stay gated
  assert.ok(!promoted.includes("browser_act_0"));
  // existing active tools are preserved
  assert.ok(promoted.includes(CALL_TOOL_NAME) && promoted.includes("bash"));
});

test("call_tool: unknown and ambiguous names return guidance, never throw", async () => {
  const targets = [
    ...realisticTargets(),
    target("dup_thing", "alpha", { bareName: "thing" }),
    target("other_thing", "beta", { bareName: "thing" }),
  ];
  const gw = buildDeferredToolGateway({ targets, sessionRef: { current: null }, env: ON });
  assert.ok(gw);
  const none: any = await gw.gatewayTools[0].execute("c", { name: "ghost" }, undefined, undefined, undefined);
  assert.ok(none.content[0].text.toLowerCase().includes("no tool matches"));
  const amb: any = await gw.gatewayTools[0].execute("c", { name: "thing" }, undefined, undefined, undefined);
  assert.ok(amb.content[0].text.toLowerCase().includes("multiple"));
});

test("describe_tool returns the schema so the model can call correctly", async () => {
  const gw = buildDeferredToolGateway({
    targets: realisticTargets(),
    sessionRef: { current: null },
    env: ON,
  });
  assert.ok(gw);
  const out: any = await gw.gatewayTools[1].execute(
    "c",
    { name: "list_profiles" },
    undefined,
    undefined,
    undefined,
  );
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.name, "mcp__holapool__list_profiles");
  assert.equal(parsed.group, "holapool");
  assert.ok(parsed.parameters.properties.x);
});
