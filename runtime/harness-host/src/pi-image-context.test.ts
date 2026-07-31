import assert from "node:assert/strict";
import test from "node:test";

import { capSessionImageContext } from "./pi.js";

/**
 * Minimal AgentSession stand-in: a mutable `state.messages` accessor, matching
 * the get/set contract pi exposes.
 */
function makeSession(initial: unknown[]): {
  state: { messages: unknown[] };
  read: () => unknown[];
} {
  let messages = initial;
  return {
    state: {
      get messages() {
        return messages;
      },
      set messages(value: unknown[]) {
        messages = value;
      },
    },
    read: () => messages,
  };
}

function image(bytes: number) {
  return { type: "image", data: "x".repeat(bytes), mimeType: "image/png" };
}

function userMessage(...content: unknown[]) {
  return { role: "user", content };
}

function totalImageBytes(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown[] }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const b = block as { type?: string; data?: string };
      if (b.type === "image" && typeof b.data === "string") {
        total += b.data.length;
      }
    }
  }
  return total;
}

test("keeps images when the transcript is under budget", () => {
  const session = makeSession([
    userMessage(image(100)),
    userMessage(image(100)),
  ]);
  const elided = capSessionImageContext(session, 1000);
  assert.equal(elided, 0);
  // Untouched: both images still present.
  const msgs = session.read() as Array<{ content: Array<{ type: string }> }>;
  assert.equal(msgs[0].content[0].type, "image");
  assert.equal(msgs[1].content[0].type, "image");
});

test("evicts the OLDEST images once cumulative image bytes exceed the budget", () => {
  const session = makeSession([
    userMessage(image(600)), // oldest
    userMessage(image(600)), // middle
    userMessage(image(600)), // newest
  ]);
  // Budget 1000: newest (600) fits; middle would reach 1200 (evict); oldest evict.
  const elided = capSessionImageContext(session, 1000);
  assert.equal(elided, 2);
  const msgs = session.read() as Array<{ content: Array<{ type: string; text?: string }> }>;
  // Newest survives as an image; the two older ones became text placeholders.
  assert.equal(msgs[2].content[0].type, "image");
  assert.equal(msgs[1].content[0].type, "text");
  assert.equal(msgs[0].content[0].type, "text");
  assert.match(msgs[0].content[0].text ?? "", /image omitted/);
});

test("preserves non-image content blocks alongside an evicted image", () => {
  const session = makeSession([
    userMessage({ type: "text", text: "before" }, image(5000), { type: "text", text: "after" }),
    userMessage(image(50)),
  ]);
  const elided = capSessionImageContext(session, 100);
  assert.equal(elided, 1);
  const msgs = session.read() as Array<{ content: Array<{ type: string; text?: string }> }>;
  // The oldest message's text blocks are untouched; only its image is swapped.
  assert.equal(msgs[0].content[0].text, "before");
  assert.equal(msgs[0].content[1].type, "text");
  assert.equal(msgs[0].content[2].text, "after");
  // Newest small image (50 <= 100) is retained.
  assert.equal(msgs[1].content[0].type, "image");
});

test("REGRESSION (diagnostics 2026-07-29): an image-bloated transcript is brought back under the provider request-size ceiling", () => {
  // The tester's session accumulated ~106MB of full-res screenshots across many
  // turns, pushing the request past the provider's ~30MB ceiling (413
  // request_too_large) and wedging auto-compaction — the agent "paused after
  // reporting compaction". Reproduce that shape (40 messages x ~1MB image each,
  // ~40MB total) and assert the prune brings it under the ceiling.
  const PROVIDER_REQUEST_CEILING = 30 * 1024 * 1024;
  const budget = 16 * 1024 * 1024;
  const session = makeSession(
    Array.from({ length: 40 }, () => userMessage(image(1024 * 1024))),
  );

  const before = totalImageBytes(session.read());
  assert.ok(before > PROVIDER_REQUEST_CEILING, "fixture must start over the ceiling");

  const elided = capSessionImageContext(session, budget);
  assert.ok(elided > 0, "oversized transcript must be pruned");

  const after = totalImageBytes(session.read());
  assert.ok(after <= budget, `retained image bytes ${after} must be <= budget ${budget}`);
  assert.ok(
    after < PROVIDER_REQUEST_CEILING,
    "pruned transcript must be under the provider request-size ceiling",
  );
});

test("REGRESSION: the newest turn's images survive the prune (current turn not blinded)", () => {
  // Eviction must never drop the freshest images — those are the ones the
  // current turn is answering about.
  const session = makeSession([
    userMessage(image(20 * 1024 * 1024)), // ancient, must be evicted
    userMessage(image(1024), { type: "text", text: "latest" }), // newest, must stay
  ]);
  capSessionImageContext(session, 8 * 1024 * 1024);
  const msgs = session.read() as Array<{ content: Array<{ type: string }> }>;
  assert.equal(msgs[0].content[0].type, "text", "old oversized image evicted");
  assert.equal(msgs[1].content[0].type, "image", "newest image preserved");
});

test("is a no-op for an empty or non-array transcript", () => {
  assert.equal(capSessionImageContext(makeSession([]), 10), 0);
  assert.equal(capSessionImageContext({ state: { messages: null } }, 10), 0);
  assert.equal(capSessionImageContext(null, 10), 0);
  assert.equal(capSessionImageContext({}, 10), 0);
});
