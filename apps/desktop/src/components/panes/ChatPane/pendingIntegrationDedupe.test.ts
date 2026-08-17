import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "./types";
import {
  dedupePendingIntegrationsByIndex,
  NO_PENDING_INTEGRATIONS,
} from "./pendingIntegrationDedupe";

function assistant(
  id: string,
  pendingIntegrations?: NonNullable<ChatMessage["pendingIntegrations"]>,
): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "",
    createdAt: "2026-08-18T00:00:00.000Z",
    ...(pendingIntegrations ? { pendingIntegrations } : {}),
  } as ChatMessage;
}

function pending(providerId: string, appId: string) {
  return { provider_id: providerId, app_id: appId } as NonNullable<
    ChatMessage["pendingIntegrations"]
  >[number];
}

test("only the newest turn introducing a (provider, app) keeps the card", () => {
  const messages = [
    assistant("a", [pending("notion", "app-1")]),
    assistant("b", [pending("notion", "app-1")]),
    assistant("c", [pending("slack", "app-2")]),
  ];

  const byIndex = dedupePendingIntegrationsByIndex(messages);

  // The stale duplicate on the earlier turn is dropped — this is what stops
  // the chat stacking up Connect / Pick-account cards the user already handled.
  assert.deepEqual(byIndex[0], []);
  assert.equal(byIndex[1]?.length, 1);
  assert.equal(byIndex[2]?.length, 1);
});

test("provider/app matching is case- and whitespace-insensitive", () => {
  const messages = [
    assistant("a", [pending("  Notion ", "APP-1")]),
    assistant("b", [pending("notion", "app-1")]),
  ];

  const byIndex = dedupePendingIntegrationsByIndex(messages);
  assert.deepEqual(byIndex[0], []);
  assert.equal(byIndex[1]?.length, 1);
});

// The rest of this file is the actual point: AssistantTurn's memo comparator
// checks `prev.pendingIntegrations === next.pendingIntegrations`, so these
// arrays must keep their identity across renders or the memo can never hit.

test("messages with no pending integrations all share one empty array", () => {
  const byIndex = dedupePendingIntegrationsByIndex([
    assistant("a"),
    assistant("b"),
  ]);

  assert.equal(byIndex[0], NO_PENDING_INTEGRATIONS);
  assert.equal(byIndex[1], NO_PENDING_INTEGRATIONS);
});

test("a turn whose entries all survive reuses the message's own array", () => {
  const entries = [pending("notion", "app-1")];
  const messages = [assistant("a", entries)];

  // Not merely deep-equal: the SAME reference. A defensive copy here would
  // change identity every render and defeat the memo just as the old inline
  // .filter() did.
  assert.equal(dedupePendingIntegrationsByIndex(messages)[0], entries);
});

test("repeated calls on unchanged input return identical references", () => {
  const messages = [
    assistant("a", [pending("notion", "app-1")]),
    assistant("b", [pending("notion", "app-1")]),
    assistant("c"),
  ];

  const first = dedupePendingIntegrationsByIndex(messages);
  const second = dedupePendingIntegrationsByIndex(messages);

  // Index 1 and 2 are the memo-critical cases: unchanged input must yield
  // reference-equal props. (Index 0 is a filtered copy, so it is legitimately
  // a new array each call — but useMemo means it is only computed when
  // `messages` actually changes.)
  assert.equal(second[1], first[1]);
  assert.equal(second[2], first[2]);
});
