import { mergeAttributes, Node } from "@tiptap/core";
import { useAtomValue } from "jotai";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";

import { Feather } from "@/components/ui/icons";
import { EntityChip } from "@/components/ui/entity-chip";
import { SKILL_MENTION_NAME } from "./composerValue";
import { skillTitlesAtom } from "./skillTitles";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    skillMention: {
      insertSkillMention: (attrs: {
        skillId: string;
        title: string;
      }) => ReturnType;
    };
  }
}

function SkillMentionChip({ node }: NodeViewProps) {
  const skillId = String(node.attrs.skillId ?? "");
  // The live list wins over the title baked into the node: a chip inserted
  // before the workspace's skills had loaded stored the raw id, and nothing
  // would ever revisit it.
  const titles = useAtomValue(skillTitlesAtom);
  const title = titles[skillId] || String(node.attrs.title ?? "") || skillId;
  return (
    <NodeViewWrapper as="span" className="mr-1 inline-flex align-middle">
      <EntityChip
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        icon={<Feather className="size-3 text-muted-foreground" />}
        label={title}
        contentEditable={false}
      />
    </NodeViewWrapper>
  );
}

export const SkillMention = Node.create({
  name: SKILL_MENTION_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      skillId: { default: "" },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-skill-mention]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-skill-mention": "",
        "data-skill-id": HTMLAttributes.skillId ?? "",
      }),
    ];
  },

  renderText({ node }) {
    return `/${node.attrs.skillId}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(SkillMentionChip);
  },

  addCommands() {
    return {
      insertSkillMention:
        (attrs) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: SKILL_MENTION_NAME, attrs })
            .insertContent(" ")
            .run(),
    };
  },
});
