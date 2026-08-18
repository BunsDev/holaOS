import assert from "node:assert/strict";
import { test } from "node:test";

import { harnessInProcessEnabled } from "./ts-runner.js";

/**
 * The default is the product decision here, so it is pinned. Flipping it back
 * should be a deliberate edit with a reason, not a side effect.
 */

test("in-process is the default when the flag is unset", () => {
  assert.equal(harnessInProcessEnabled({}), true);
  assert.equal(harnessInProcessEnabled({ HB_HARNESS_IN_PROCESS: "" }), true);
  assert.equal(harnessInProcessEnabled({ HB_HARNESS_IN_PROCESS: "   " }), true);
});

test("the escape hatch turns it off", () => {
  // This is the rollback if long sessions stop compacting (blocker 4), so it
  // has to work for the spellings someone reaches for under pressure.
  for (const value of ["0", "false", "off", "FALSE", "Off"]) {
    assert.equal(
      harnessInProcessEnabled({ HB_HARNESS_IN_PROCESS: value }),
      false,
      `${value} should disable the in-process path`,
    );
  }
});

test("an explicit enable still enables", () => {
  for (const value of ["1", "true", "yes"]) {
    assert.equal(harnessInProcessEnabled({ HB_HARNESS_IN_PROCESS: value }), true);
  }
});
