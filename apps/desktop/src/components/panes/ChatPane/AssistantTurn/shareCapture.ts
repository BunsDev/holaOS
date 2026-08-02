import type {
  ShareDraftFile,
  ShareDraftGeneration,
  ShareDraftImage,
  ShareDraftItem,
  ShareDraftSessionStep,
  ShareDraftSessionTurn,
} from "@holaboss/app-host/protocol";
import { remoteApi } from "@/lib/remoteApiClient";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";
import { parseSerializedQuotedSkillPrompt } from "../helpers";
import type { ChatExecutionTimelineItem, ChatMessage } from "../types";

// A minimal shape both WorkspaceOutputRecordPayload and the Remote API's
// OutputItem satisfy — so the same capture path serves the turn rows and the
// session Outputs popover.
export type ShareableOutput = {
  id: string;
  file_path?: string | null;
  module_id?: string | null;
  /** The turn that produced this output — how a share finds the exact prompt. */
  input_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

const SHARE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const MAX_SHARE_IMAGES = 4;
// Mirrors the hub's own per-image limit. Capturing a larger one only moves the
// rejection downstream, where it lands as a failed upload with no explanation.
const MAX_SHARE_IMAGE_BYTES = 10 * 1024 * 1024;

const SHARE_VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
// Cap the share-via-base64 video so it doesn't choke the IPC bridge; larger clips
// can be attached manually in the composer (uploaded directly with the session).
const MAX_SHARE_VIDEO_BYTES = 50 * 1024 * 1024;

function extOf(path: string, table: Record<string, string>): string | null {
  const lower = path.toLowerCase();
  return Object.keys(table).find((e) => lower.endsWith(e)) ?? null;
}

/** True when an output is a generated image/video we can attach to a HolaHub post. */
export function isShareableMediaOutput(
  output: ShareableOutput
): boolean {
  const path = output.file_path;
  return Boolean(
    path && (extOf(path, SHARE_IMAGE_MIME) || extOf(path, SHARE_VIDEO_MIME))
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** What a capture had to leave behind, so the caller can say so. A share that
 *  silently drops an artifact is indistinguishable from a broken button. */
export type SkippedArtifact = {
  name: string;
  reason: "too-large" | "unreadable" | "no-workspace";
};

export function describeSkipped(skipped: SkippedArtifact[]): string {
  if (skipped.length === 0) {
    return "";
  }
  if (skipped.some((s) => s.reason === "no-workspace")) {
    return "This chat has no workspace, so its files can't be read.";
  }
  const tooLarge = skipped.filter((s) => s.reason === "too-large");
  if (tooLarge.length === skipped.length) {
    const limit = Math.round(MAX_SHARE_IMAGE_BYTES / (1024 * 1024));
    return skipped.length === 1
      ? `${tooLarge[0].name} couldn't be brought under the ${limit}MB share limit.`
      : `${skipped.length} artifacts couldn't be brought under the ${limit}MB share limit.`;
  }
  return skipped.length === 1
    ? `${skipped[0].name} could not be read.`
    : `${skipped.length} artifacts could not be included.`;
}

// A feed image gains nothing past this on either the card or the full-screen
// viewer, and a generated poster routinely arrives several times larger.
const MAX_SHARE_IMAGE_EDGE = 2048;
// WebP over JPEG so a poster with transparency survives; the hub accepts both.
const RECOMPRESS_TYPE = "image/webp";
const RECOMPRESS_QUALITIES = [0.9, 0.8, 0.65];

/**
 * Bring an oversized image under the limit by capping its longest edge and
 * re-encoding, dropping quality only if that alone is not enough. Lossy by
 * definition — but the alternative was refusing to share it, and the prompt that
 * made it travels separately, so what a viewer needs to reproduce it is intact.
 *
 * Null when it cannot be brought under, or when the format should not be touched
 * (an animated GIF would come back as a single frame).
 */
async function recompressImage(
  bytes: Uint8Array,
  contentType: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (contentType === "image/gif") {
    return null;
  }
  try {
    // Copy into a plain ArrayBuffer: a Uint8Array over a SharedArrayBuffer is
    // not a BlobPart, and what readFileBytes hands back is not guaranteed.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const source = await createImageBitmap(new Blob([buffer], { type: contentType }));
    const scale = Math.min(
      1,
      MAX_SHARE_IMAGE_EDGE / Math.max(source.width, source.height)
    );
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(source.width * scale)),
      Math.max(1, Math.round(source.height * scale))
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close();
    for (const quality of RECOMPRESS_QUALITIES) {
      const blob = await canvas.convertToBlob({
        type: RECOMPRESS_TYPE,
        quality,
      });
      if (blob.size > 0 && blob.size <= MAX_SHARE_IMAGE_BYTES) {
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          contentType: RECOMPRESS_TYPE,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Capture generated image outputs (by file extension) as base64 so the HolaHub
// composer — which holds the session — can upload them on prefill.
export async function gatherShareImages(
  outputs: ShareableOutput[],
  workspaceId: string | null,
  skipped?: SkippedArtifact[]
): Promise<ShareDraftImage[]> {
  if (!workspaceId) {
    skipped?.push({ name: "", reason: "no-workspace" });
    return [];
  }
  const images: ShareDraftImage[] = [];
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_IMAGE_MIME) : null;
    if (!(path && ext)) {
      continue;
    }
    try {
      const raw = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      if (raw.length === 0) {
        skipped?.push({ name: baseName(path), reason: "unreadable" });
        continue;
      }
      let bytes = raw;
      let contentType = SHARE_IMAGE_MIME[ext];
      if (bytes.length > MAX_SHARE_IMAGE_BYTES) {
        const smaller = await recompressImage(bytes, contentType);
        if (!smaller) {
          skipped?.push({ name: baseName(path), reason: "too-large" });
          continue;
        }
        bytes = smaller.bytes;
        contentType = smaller.contentType;
      }
      images.push({
        dataBase64: bytesToBase64(bytes),
        contentType,
        ...(generationOf(output) ? { generation: generationOf(output) } : {}),
      });
    } catch {
      skipped?.push({ name: baseName(path), reason: "unreadable" });
    }
    if (images.length >= MAX_SHARE_IMAGES) {
      break;
    }
  }
  return images;
}

// Capture the first small-enough generated video (by extension) as base64.
export async function gatherShareVideos(
  outputs: ShareableOutput[],
  workspaceId: string | null
): Promise<ShareDraftImage[]> {
  if (!workspaceId) {
    return [];
  }
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_VIDEO_MIME) : null;
    if (!(path && ext)) {
      continue;
    }
    try {
      const bytes = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      if (bytes.length === 0 || bytes.length > MAX_SHARE_VIDEO_BYTES) {
        continue;
      }
      return [
        {
          dataBase64: bytesToBase64(bytes),
          contentType: SHARE_VIDEO_MIME[ext],
          ...(generationOf(output) ? { generation: generationOf(output) } : {}),
        },
      ];
    } catch {
      // Unreadable — try the next output.
    }
  }
  return [];
}

// Deliverable documents (pptx/docx/pdf/…) — shareable inside a session as
// downloadable file cards. Extension → MIME (advisory; the server gates by ext).
const SHARE_DOC_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
};
const MAX_SHARE_FILE_BYTES = 50 * 1024 * 1024;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "file";
}

// Internal tool-call artifacts (e.g. "search_web-call_<hex>.json", raw tool
// dumps) are outputs but NOT deliverables — they must never end up in a share.
const INTERNAL_ARTIFACT_RE = /[-_]call_[0-9a-f]{6,}/i;
function isInternalArtifact(path: string): boolean {
  return INTERNAL_ARTIFACT_RE.test(baseName(path));
}

/** True when an output is a shareable deliverable document (not an image/video,
 *  and not an internal tool-call artifact). */
export function isShareableDocOutput(output: ShareableOutput): boolean {
  const path = output.file_path;
  return Boolean(
    path && extOf(path, SHARE_DOC_MIME) && !isInternalArtifact(path)
  );
}

/** Anything a reader could receive: a picture, a clip, or a deliverable to open.
 *  The per-artifact Share affordance asks this rather than the media-only test,
 *  which is why a turn that produced only a deck offered no way to share it. */
export function isShareableOutput(output: ShareableOutput): boolean {
  return isShareableMediaOutput(output) || isShareableDocOutput(output);
}

/** Capture document outputs as base64 (keeping the original file name) so the
 *  HolaHub composer can upload them — the download-card path for a session. */
export async function gatherShareFiles(
  outputs: ShareableOutput[],
  workspaceId: string | null
): Promise<ShareDraftFile[]> {
  if (!workspaceId) {
    return [];
  }
  const files: ShareDraftFile[] = [];
  for (const output of outputs) {
    const path = output.file_path;
    const ext = path ? extOf(path, SHARE_DOC_MIME) : null;
    if (!(path && ext) || isInternalArtifact(path)) {
      continue;
    }
    try {
      const bytes = await window.electronAPI.fs.readFileBytes(path, workspaceId);
      if (bytes.length === 0 || bytes.length > MAX_SHARE_FILE_BYTES) {
        continue;
      }
      files.push({
        fileName: baseName(path),
        contentType: SHARE_DOC_MIME[ext],
        dataBase64: bytesToBase64(bytes),
      });
    } catch {
      // Unreadable output — skip it.
    }
  }
  return files;
}

// The simplified tool/phase trace of an assistant turn — just step titles (no
// args/output), so a shared post can show "Worked across N steps". Trace steps
// live in `segments` (execution) on newer turns, or the flat `executionItems`.
function stepsFromMessage(message: ChatMessage): ShareDraftSessionStep[] {
  const items: ChatExecutionTimelineItem[] = [];
  if (message.segments && message.segments.length > 0) {
    for (const segment of message.segments) {
      if (segment.kind === "execution") {
        items.push(...segment.items);
      }
    }
  } else if (message.executionItems) {
    items.push(...message.executionItems);
  }
  const steps: ShareDraftSessionStep[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "trace_step") {
      continue;
    }
    const title = (item.step.title ?? "").trim();
    if (!title || item.step.status === "error" || seen.has(title)) {
      continue;
    }
    seen.add(title);
    steps.push({ title, kind: item.step.kind });
    if (steps.length >= 10) {
      break;
    }
  }
  return steps;
}

// The assistant's visible reply lives in `segments` (kind "output") once a turn
// is segmented — `message.text` is cleared then. Read the output segments (what
// the desktop actually renders), falling back to message.text.
export function visibleText(message: ChatMessage): string {
  const segments = message.segments ?? [];
  if (segments.length > 0) {
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment.kind === "output") {
        parts.push(segment.text);
      }
    }
    const joined = parts.join("\n\n").trim();
    if (joined) {
      return joined;
    }
  }
  return (message.text ?? "").trim();
}

/** Build a shareable conversation transcript from the assembled chat messages.
 *  Text + a simplified step trace per turn (no thinking/args/output) + its
 *  media/files captured to base64; local paths and metadata never leave. */
export async function gatherSessionSnapshot(
  messages: ChatMessage[],
  workspaceId: string | null,
  // Friendly model name for this session (e.g. "Claude Opus 4.8"), stamped on
  // assistant turns so a shared post can annotate which model replied.
  modelLabel?: string | null
): Promise<{ turns: ShareDraftSessionTurn[] }> {
  const model = (modelLabel ?? "").trim();
  const turns: ShareDraftSessionTurn[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const outputs = mergeOutputsByPath(message.outputs ?? []);
    const text = visibleText(message);
    const steps =
      message.role === "assistant" ? stepsFromMessage(message) : [];
    const [images, videos, files] = await Promise.all([
      gatherShareImages(outputs, workspaceId),
      gatherShareVideos(outputs, workspaceId),
      gatherShareFiles(outputs, workspaceId),
    ]);
    // Skip a turn with nothing to show — no text, media, or steps.
    if (
      !text &&
      images.length === 0 &&
      videos.length === 0 &&
      files.length === 0 &&
      steps.length === 0
    ) {
      continue;
    }
    turns.push({
      role: message.role,
      text,
      createdAt: message.createdAt ?? null,
      ...(images.length > 0 ? { images } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(steps.length > 0 ? { steps } : {}),
      ...(message.role === "assistant" && model ? { model } : {}),
    });
  }
  return { turns };
}

/**
 * The turns that produced these outputs. An output knows the input it came from,
 * and the renderer keys its assistant turn as `assistant-<inputId>` — the user
 * turn is the one before it, since its own id is a client-side timestamp with no
 * relation to the input. Empty when nothing matches, which is what happens for
 * an output the renderer never rendered a turn for.
 */
export function turnsForOutputs(
  outputs: ShareableOutput[],
  messages: ChatMessage[]
): ChatMessage[] {
  const found: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const output of outputs) {
    const inputId = output.input_id;
    if (!inputId) {
      continue;
    }
    const index = messages.findIndex((m) => m.id === `assistant-${inputId}`);
    if (index < 0) {
      continue;
    }
    for (const candidate of [messages[index - 1], messages[index]]) {
      if (candidate && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * The prompt a viewer needs to make their own equivalent: the ask that produced
 * these outputs, falling back to the conversation's opening ask. Any quoted-skill
 * command lines are stripped — the skills travel as items, and leaving the raw
 * `/skill` lines in would seed a prompt that only runs for someone who happens to
 * have them installed.
 */
export function resolveRecipePrompt(
  outputs: ShareableOutput[],
  messages: ChatMessage[]
): string {
  const source =
    turnsForOutputs(outputs, messages).find((m) => m.role === "user") ??
    messages.find((m) => m.role === "user");
  const text = (source?.text ?? "").trim();
  if (!text) {
    return "";
  }
  return parseSerializedQuotedSkillPrompt(text).body.trim() || text;
}

/**
 * The tools the sharer explicitly reached for in these turns. A quoted skill is
 * a detection — they picked it out of the composer and it ran — so it travels as
 * `derived` and the composer will not let them drop it. A quoted integration is
 * a prerequisite rather than an actor (it surfaces as an app or MCP call when it
 * is really used), so it rides along as a plain recommendation.
 */
export function gatherQuotedToolItems(
  messages: ChatMessage[],
  names: { skills: Record<string, string>; integrations: Record<string, string> }
): ShareDraftItem[] {
  const items: ShareDraftItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const quoted = parseSerializedQuotedSkillPrompt(message.text ?? "");
    for (const skillId of quoted.skillIds) {
      const key = `skill:${skillId}`;
      if (skillId && !seen.has(key)) {
        seen.add(key);
        items.push({
          type: "skill",
          ref: skillId,
          name: names.skills[skillId] ?? skillId,
          origin: "derived",
        });
      }
    }
    for (const slug of quoted.integrationSlugs) {
      const key = `integration:${slug}`;
      if (slug && !seen.has(key)) {
        seen.add(key);
        items.push({
          type: "integration",
          ref: slug,
          name: names.integrations[slug] ?? slug,
          origin: "attached",
        });
      }
    }
  }
  return items;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The generation behind one artifact, off the metadata the runtime stamped.
 *  Undefined when the producing tool recorded none — a file the end-of-turn scan
 *  merely noticed has no generation to report. */
function generationOf(
  output: ShareableOutput
): ShareDraftGeneration | undefined {
  const meta = output.metadata;
  if (!meta) {
    return undefined;
  }
  const generation: ShareDraftGeneration = {
    prompt: nonEmpty(meta.prompt),
    revisedPrompt: nonEmpty(meta.revised_prompt),
    model: nonEmpty(meta.model) ?? nonEmpty(meta.model_id),
    provider: nonEmpty(meta.provider),
    size: nonEmpty(meta.image_size) ?? nonEmpty(meta.video_size),
    seconds:
      typeof meta.video_seconds === "number" ? meta.video_seconds : undefined,
  };
  return Object.values(generation).some((v) => v !== undefined)
    ? generation
    : undefined;
}

/**
 * One artifact, one entry. The runtime writes a record every time a file is
 * touched — `image_generate` creates it, then `send_file` delivers it — and only
 * the first one knows the prompt. Left as-is the picker offers the same image
 * twice and a share that lands on the later record reports no generation at all.
 */
export function mergeOutputsByPath<T extends ShareableOutput>(
  outputs: T[]
): T[] {
  const byPath = new Map<string, T>();
  const order: string[] = [];
  for (const output of outputs) {
    const key = output.file_path ?? output.id;
    const seen = byPath.get(key);
    if (seen) {
      // The kept record keeps its own fields and fills its gaps from the other.
      byPath.set(key, {
        ...seen,
        metadata: { ...(output.metadata ?? {}), ...(seen.metadata ?? {}) },
      });
      continue;
    }
    byPath.set(key, output);
    order.push(key);
  }
  return order.flatMap((key) => {
    const output = byPath.get(key);
    return output ? [output] : [];
  });
}

/** Every record the runtime holds for these turns — including the ones the chat
 *  never rendered. Best-effort: a share must not fail because a lookup did. */
export async function outputRecordsForTurns(
  workspaceId: string | null,
  outputs: ShareableOutput[]
): Promise<ShareableOutput[]> {
  const inputIds = [
    ...new Set(
      outputs.flatMap((o) => (o.input_id ? [o.input_id] : []))
    ),
  ];
  if (!workspaceId || inputIds.length === 0) {
    return [];
  }
  const batches = await Promise.all(
    inputIds.map((inputId) =>
      // The runtime is single-tenant and resolves the workspace server-side, so
      // the contract carries no workspaceId — it is only a guard here.
      remoteApi.outputs
        .list({ inputId, limit: 50 })
        .then((r) => r.items as ShareableOutput[])
        .catch(() => [] as ShareableOutput[])
    )
  );
  return batches.flat();
}

/**
 * Fill each output's metadata gaps from any other record of the same file.
 *
 * The chat renders what the agent *delivered*, and a delivery record describes
 * the delivery — the record that knows the prompt is the one `image_generate`
 * wrote, which the turn never renders. Same file, same turn, two rows; without
 * this the share reads the wrong one and reports no generation at all.
 *
 * Adds nothing: the result is exactly the outputs passed in.
 */
export function enrichOutputs<T extends ShareableOutput>(
  outputs: T[],
  pool: ShareableOutput[]
): T[] {
  if (pool.length === 0) {
    return outputs;
  }
  const byPath = new Map<string, Record<string, unknown>>();
  for (const candidate of pool) {
    const key = candidate.file_path;
    if (!(key && candidate.metadata)) {
      continue;
    }
    byPath.set(key, { ...candidate.metadata, ...(byPath.get(key) ?? {}) });
  }
  return outputs.map((output) => {
    const extra = output.file_path ? byPath.get(output.file_path) : undefined;
    return extra
      ? { ...output, metadata: { ...extra, ...(output.metadata ?? {}) } }
      : output;
  });
}

/**
 * The model that actually generated these artifacts, read from the output
 * metadata the runtime already stamps (`model` on a written report, `model_id`
 * on a generated image). Display-only: a reader of a generated sample should be
 * able to see what made it, but it is not a session model and is never seeded
 * as one. Empty when the producing tool records no model.
 */
export function resolveOutputModel(outputs: ShareableOutput[]): string {
  for (const output of outputs) {
    const meta = output.metadata;
    if (!meta) {
      continue;
    }
    const value = meta.model ?? meta.model_id;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

// Attribute a share to the apps that actually produced these outputs (their
// `module_id`), not every capability installed — so the credited/installable
// items reflect what made the content.
export function gatherShareAttributionItems(
  outputs: ShareableOutput[]
): ShareDraftItem[] {
  const items: ShareDraftItem[] = [];
  const seen = new Set<string>();
  for (const output of outputs) {
    const moduleId = (output.module_id ?? "").trim().toLowerCase();
    if (!moduleId || seen.has(moduleId)) {
      continue;
    }
    seen.add(moduleId);
    items.push({
      type: "holaapp",
      ref: moduleId,
      name: toolkitDisplayName(moduleId),
      origin: "derived",
    });
  }
  return items;
}
