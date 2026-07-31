import type {
  AppContext,
  ChatStartAttachment,
} from "@holaboss/app-host/protocol";
import { useSetAtom } from "jotai";
import { persistMediaGenerationModel } from "@/lib/mediaGenerationConfig";
import { imageComposerModeAtom } from "@/components/panes/ChatPane/Composer/imageMode";
import { useEffect, useRef } from "react";
import {
  chatAppContextAttachmentRequestAtom,
  chatLocalAttachmentRequestAtom,
  chatModelRequestAtom,
  chatComposerPrefillAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  sessionLastViewedAtAtom,
  workspaceOverlayAtom,
} from "./state/ui";

/** "need-review" → "Need Review" for the attachment card label. */
function prettyAppName(app: string): string {
  return (
    app
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || app
  );
}

/** Serialize an AppContext into the text folded into the message on send, so
 * the agent gets the record's refs + how to expand it (MCP) + any snapshot —
 * even when the app's MCP server isn't attached to the session. */
function appContextToText(ctx: AppContext): string {
  const lines: string[] = [
    `Context — ${prettyAppName(ctx.app)}${ctx.kind ? ` ${ctx.kind}` : ""}: "${ctx.title}"`,
  ];
  for (const [key, value] of Object.entries(ctx.refs ?? {})) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  if (ctx.mcp?.server) {
    const hint = ctx.mcp.hint ? ` — ${ctx.mcp.hint}` : "";
    lines.push(`Expand it via the ${ctx.mcp.server} MCP${hint}.`);
  }
  if (ctx.snapshot?.content?.trim()) {
    lines.push("", "--- snapshot ---", ctx.snapshot.content.trim());
  }
  return lines.join("\n");
}

/**
 * Bridges the host op `window.__holabossHost.chat.start` into the shell. Main
 * creates the session for the calling web HolaApp surface, then emits
 * `host:openChat`; here we open that session in the chat panel, prefill the
 * composer prompt, and drop each supplied AppContext into the composer as a
 * removable attachment card (its context folds into the message on send).
 *
 * The calling HolaApp surface stays in the center column (focus mode off → the
 * split layout shows the app + the new chat side by side), so "Discuss" lands
 * in context. Mount once at the shell root.
 */
/** base64 → File, so a hand-off attachment joins the same pending-attachment
 *  path a dropped file uses. Null on anything malformed — a bad reference should
 *  cost the attachment, not the hand-off. */
function decodeChatStartAttachment(input: unknown): File | null {
  const a = input as Partial<ChatStartAttachment> | null;
  if (!(a?.dataBase64 && a.contentType)) {
    return null;
  }
  try {
    const binary = atob(a.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], a.fileName?.trim() || "reference", {
      type: a.contentType,
    });
  } catch {
    return null;
  }
}

export function useHostOpenChat(): void {
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const setImageComposerMode = useSetAtom(imageComposerModeAtom);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setAppContextAttachmentRequest = useSetAtom(
    chatAppContextAttachmentRequestAtom,
  );
  const setChatModelRequest = useSetAtom(chatModelRequestAtom);
  const setLocalAttachmentRequest = useSetAtom(chatLocalAttachmentRequestAtom);
  const seqRef = useRef(0);

  useEffect(() => {
    const off = window.electronAPI.host.onOpenChat((payload) => {
      const sessionId = payload.session?.session_id;
      if (!sessionId) {
        return;
      }
      setProjectView(null);
      setWorkspaceOverlay(null);
      setFocusMode(false);
      setChatPanelView("chat");
      setSelectedSessionId(sessionId);
      seqRef.current += 1;
      setSessionOpenRequest({
        sessionId,
        requestKey: seqRef.current,
        readOnly: false,
      });
      setLastViewedMap((prev) => ({
        ...prev,
        [sessionId]: new Date().toISOString(),
      }));

      const requestedModel =
        typeof payload.input?.model === "string" ? payload.input.model.trim() : "";
      if (requestedModel) {
        seqRef.current += 1;
        setChatModelRequest({
          model: requestedModel,
          requestKey: seqRef.current,
        });
      }

      // The image tool takes no model, so reproducing an artifact faithfully
      // means setting the workspace's image-generation model. Paired with image
      // mode below, so the model pill in the composer shows what changed rather
      // than the setting moving silently.
      const requestedImageModel =
        typeof payload.input?.imageModel === "string"
          ? payload.input.imageModel.trim()
          : "";
      if (requestedImageModel) {
        void persistMediaGenerationModel("image", requestedImageModel).catch(
          () => {
            // Config unwritable — the session still opens, on the current model.
          }
        );
        setImageComposerMode(true);
      }

      // A reference Output rides in as base64 and lands as an ordinary pending
      // attachment, so the composer's own image-support check and remove button
      // both apply without knowing where it came from.
      const attachments = Array.isArray(payload.input?.attachments)
        ? payload.input.attachments
        : [];
      const files = attachments
        .map((a) => decodeChatStartAttachment(a))
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        seqRef.current += 1;
        setLocalAttachmentRequest({ files, requestKey: seqRef.current });
      }

      const prompt =
        typeof payload.input?.prompt === "string" ? payload.input.prompt : "";
      // Quoted skills serialize as leading `/id` lines that the composer's prefill
      // parse (parseSerializedQuotedSkillPrompt) turns back into skill chips — a
      // blank line then separates them from the body. So an opened skill lands as
      // a real skill chip, not a generic context pill.
      const skillLines = (
        Array.isArray(payload.input?.skillIds) ? payload.input.skillIds : []
      )
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => `/${id.trim()}`);
      const prefillText =
        skillLines.length > 0
          ? [skillLines.join("\n"), prompt].filter(Boolean).join("\n\n")
          : prompt;
      if (prefillText) {
        seqRef.current += 1;
        setComposerPrefill({
          text: prefillText,
          requestKey: seqRef.current,
          mode: "replace",
          sessionMode: "preserve",
          autoSubmit: payload.input?.autoSubmit === true,
        });
      }

      const contexts = Array.isArray(payload.input?.context)
        ? payload.input.context
        : [];
      const items = contexts
        .filter((ctx): ctx is AppContext => Boolean(ctx?.app && ctx?.title))
        .map((ctx) => ({
          appName: prettyAppName(ctx.app),
          title: ctx.title,
          contextText: appContextToText(ctx),
        }));
      if (items.length > 0) {
        seqRef.current += 1;
        setAppContextAttachmentRequest({ items, requestKey: seqRef.current });
      }
    });
    return off;
  }, [
    setSelectedSessionId,
    setSessionOpenRequest,
    setChatPanelView,
    setComposerPrefill,
    setLastViewedMap,
    setFocusMode,
    setProjectView,
    setChatModelRequest,
    setLocalAttachmentRequest,
    setWorkspaceOverlay,
    setAppContextAttachmentRequest,
  ]);
}
