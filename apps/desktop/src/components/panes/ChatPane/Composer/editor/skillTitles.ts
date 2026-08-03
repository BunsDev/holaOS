import { atom } from "jotai";

/**
 * Live `skillId → display title`, published by ChatPane from the workspace's
 * skill list.
 *
 * A skill chip stores its title in the document node, resolved once when the
 * document is built. Seed a composer in the same breath as an install — which is
 * exactly what "install, then open a chat with it quoted" does — and the skill
 * list has not arrived yet, so the raw id gets written into the node and stays
 * there: `c_f209f381-267e-49e8-8673-64a7ebf8cdc2`. Reading through this atom
 * lets the chip heal once the list lands, and follow a rename after that.
 */
export const skillTitlesAtom = atom<Record<string, string>>({});
