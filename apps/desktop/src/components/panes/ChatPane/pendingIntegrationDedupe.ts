import type { ChatMessage } from "./types";

type PendingIntegrations = NonNullable<ChatMessage["pendingIntegrations"]>;

/**
 * Shared empty array for turns with no pending integrations.
 *
 * AssistantTurn is memoized on a comparator that compares this prop by
 * reference, so handing it a fresh `[]` literal defeats the memo for every
 * message that simply does not have the field — which is nearly all of them.
 */
export const NO_PENDING_INTEGRATIONS: PendingIntegrations = [];

function integrationKey(entry: PendingIntegrations[number]): string {
  return `${entry.provider_id.trim().toLowerCase()}|${entry.app_id.trim().toLowerCase()}`;
}

/**
 * Per-message pending-integration cards, deduped so only the newest assistant
 * turn that introduced a given `(provider, app_id)` keeps the interactive card.
 *
 * The agent re-emits the same proposal on every tool call, so without this the
 * chat accumulates stacks of stale Connect / Pick-account cards from earlier
 * turns even after the user has authorized.
 *
 * Returns one entry per message index. Callers must treat the result as
 * immutable: identity is the point. Every returned array is either a shared
 * empty, the message's own array, or a filtered copy — so for unchanged input
 * the references are stable, which is what lets AssistantTurn's memo hit.
 */
export function dedupePendingIntegrationsByIndex(
  messages: readonly ChatMessage[],
): PendingIntegrations[] {
  const latestIndexByKey = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (const entry of message.pendingIntegrations ?? []) {
      const key = integrationKey(entry);
      if (!key) continue;
      latestIndexByKey.set(key, i);
    }
  }

  const byIndex: PendingIntegrations[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const entries = messages[i]?.pendingIntegrations;
    if (!entries?.length) {
      byIndex[i] = NO_PENDING_INTEGRATIONS;
      continue;
    }
    const kept = entries.filter((entry) => latestIndexByKey.get(integrationKey(entry)) === i);
    // Nothing dropped → reuse the message's own array rather than the copy
    // `.filter()` just made, so identity tracks the message itself.
    byIndex[i] = kept.length === entries.length ? entries : kept;
  }
  return byIndex;
}
