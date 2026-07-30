// Cap the images a TOOL returns before they re-enter the model context.
//
// Custom image-producing tools (browser screenshots, read-in images, generated
// images) return RAW base64 straight to the model. A handful of full-res images
// in one turn stacks megabytes of base64 into the mid-loop request and can push
// it past the provider's ~30MB request-size ceiling (413 request_too_large).
//
// Fix: route every tool result's image blocks through pi's OWN native
// `resizeImage` (@earendil-works/pi-coding-agent — the same downscaler its built-in
// read tool uses; Photon/WASM, no native binary to bundle, no extra dependency).
// The model still sees the image, just downscaled. Applied to ALL tools in pi.ts,
// so it covers every run uniformly. Mirrors the backend agent_operator's
// tool_image_cap.ts — one downscaler across desktop + backend.

import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Long-edge pixel cap (env-tunable). 2576 matches current vision models' own
 * high-res ceiling, so small text (numbers, fine print) in screenshots survives. */
export const TOOL_IMAGE_MAX_DIM =
  Number(process.env.HOLABOSS_TOOL_IMAGE_MAX_DIM) || 2576;
/** Encoded-byte budget per tool-result image — tight enough that a burst of
 * generated images in one turn stays well under the provider request ceiling. */
export const TOOL_IMAGE_MAX_BYTES =
  Number(process.env.HOLABOSS_TOOL_IMAGE_MAX_BYTES) || 1_500_000;
/** Skip images whose base64 is already comfortably small (no decode/re-encode). */
export const TOOL_IMAGE_TRIGGER_BYTES =
  Number(process.env.HOLABOSS_TOOL_IMAGE_TRIGGER_BYTES) || 700_000;

export interface ToolImageCapOptions {
  maxDim: number;
  maxBytes: number;
  triggerBytes: number;
}

function defaultOptions(): ToolImageCapOptions {
  return {
    maxDim: TOOL_IMAGE_MAX_DIM,
    maxBytes: TOOL_IMAGE_MAX_BYTES,
    triggerBytes: TOOL_IMAGE_TRIGGER_BYTES,
  };
}

/** The subset of pi's `resizeImage` we depend on — injectable for tests. */
export type ImageResizer = (
  bytes: Uint8Array,
  mimeType: string,
  options: { maxWidth: number; maxHeight: number; maxBytes: number },
) => Promise<{ data: string; mimeType: string } | null>;

function isImageBlock(
  block: unknown,
): block is { type: "image"; data: string; mimeType?: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

/**
 * Downscale a single image content block if it exceeds the trigger. Best-effort:
 * returns the ORIGINAL block on any failure, if the image is already small, or if
 * the re-encode wouldn't save bytes — a tool result is never dropped.
 */
async function capImageBlock<T>(
  block: T,
  opts: ToolImageCapOptions,
  resize: ImageResizer,
): Promise<T> {
  if (!isImageBlock(block) || block.data.length <= opts.triggerBytes) {
    return block;
  }
  try {
    const input = Buffer.from(block.data, "base64");
    const resized = await resize(input, block.mimeType || "image/png", {
      maxWidth: opts.maxDim,
      maxHeight: opts.maxDim,
      maxBytes: opts.maxBytes,
    });
    if (!resized || resized.data.length >= block.data.length) {
      return block;
    }
    return { ...block, data: resized.data, mimeType: resized.mimeType };
  } catch {
    return block;
  }
}

/**
 * Downscale every oversized image block in a tool result's content array. Returns
 * the SAME array reference when nothing changed so callers can skip the copy.
 * `resize` is injectable purely for tests; production uses pi's `resizeImage`.
 */
export async function capToolResultImages<T>(
  content: T[],
  opts: ToolImageCapOptions = defaultOptions(),
  resize: ImageResizer = resizeImage as unknown as ImageResizer,
): Promise<T[]> {
  if (!Array.isArray(content)) {
    return content;
  }
  let changed = false;
  const next = await Promise.all(
    content.map(async (block) => {
      const capped = await capImageBlock(block, opts, resize);
      if (capped !== block) {
        changed = true;
      }
      return capped;
    }),
  );
  return changed ? next : content;
}

/**
 * Wrap a tool so any images it returns are downscaled before the model sees them.
 * Preserves the tool's schema, name, renderer, and streaming callback; only the
 * final result's image content is post-processed.
 */
export function wrapToolWithImageCap(
  tool: ToolDefinition,
  opts: ToolImageCapOptions = defaultOptions(),
  resize: ImageResizer = resizeImage as unknown as ImageResizer,
): ToolDefinition {
  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      const result = await originalExecute(...args);
      if (!result || !Array.isArray(result.content)) {
        return result;
      }
      const content = await capToolResultImages(result.content, opts, resize);
      return content === result.content ? result : { ...result, content };
    },
  } as ToolDefinition;
}
