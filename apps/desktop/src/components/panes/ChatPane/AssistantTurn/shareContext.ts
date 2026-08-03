import { atom } from "jotai";

import type { ChatMessage } from "../types";

/**
 * What a share needs to know beyond the artifact itself: the conversation it
 * came out of, and what the tools in it are called.
 *
 * The Share panel resolves the skills a shared output was made with by looking
 * at the turns that produced it. The quick shares — the button under an artifact
 * and the one in a turn's menu — had no access to that, so they attached only
 * what the output's own `module_id` credited and a shared image arrived carrying
 * no skill at all. Published here rather than threaded through AssistantTurn,
 * which is memoized on an explicit prop comparator.
 */
export const shareContextAtom = atom<{
  messages: ChatMessage[];
  toolNames: {
    skills: Record<string, string>;
    integrations: Record<string, string>;
  };
}>({ messages: [], toolNames: { skills: {}, integrations: {} } });
