import assert from "node:assert/strict";
import test from "node:test";

import { renderPiSkillCatalog } from "./pi.js";

// pi's own <available_skills> block cost ~4,860 tokens for 41 skills — over a
// quarter of it absolute SKILL.md paths the model never needs, since holaOS
// loads skills BY NAME through the `skill` tool. This catalogue replaces it.
test("renders one line per skill, name first, no filesystem paths", () => {
  const out = renderPiSkillCatalog([
    { name: "pdf", description: "Work with PDF files" },
    { name: "social", description: "Draft social posts" },
  ]);
  assert.match(out, /- pdf — Work with PDF files/);
  assert.match(out, /- social — Draft social posts/);
  assert.ok(!out.includes("/"), "no paths anywhere in the catalogue");
  assert.match(out, /`skill` tool/, "points at the skill tool, not `read`");
});

test("caps a runaway description so one skill cannot dominate", () => {
  const out = renderPiSkillCatalog([{ name: "verbose", description: "x".repeat(1000) }]);
  assert.ok(out.length < 400, `catalogue should stay bounded, got ${out.length}`);
});

test("collapses newlines/whitespace so a multi-line description stays one line", () => {
  const out = renderPiSkillCatalog([
    { name: "multi", description: "first line\n\nsecond   line" },
  ]);
  const body = out.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(body.length, 1);
  assert.equal(body[0], "- multi — first line second line");
});

test("tolerates a missing description and emits nothing for an empty set", () => {
  assert.match(renderPiSkillCatalog([{ name: "bare" }]), /- bare$/m);
  assert.equal(renderPiSkillCatalog([]), "", "no skills -> nothing appended");
});
