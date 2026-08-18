// Cap the images a TOOL returns before they re-enter the model context.
//
// Custom image-producing tools (browser screenshots, read-in images, generated
// images) return RAW base64 straight to the model. A handful of full-res images
// in one turn stacks megabytes of base64 into the mid-loop request and can push
// it past the provider's ~30MB request-size ceiling (413 request_too_large).
//
// Fix: route every tool result's image blocks through @napi-rs/canvas (in-process,
// ALREADY a harness-host dependency for PDF rendering — no new dep, no per-platform
// native binary to bundle). Decode → resize to the long-edge cap → re-encode JPEG,
// stepping quality down to fit the byte budget. The model still sees the image,
// just downscaled. Applied to ALL tools in pi.ts, so it covers every run.
//
// NB: pi's own resizeImage (@earendil, Photon/WASM) was measured at ~2s PER image
// (a fresh worker + WASM init per call) — far too slow for image-heavy turns.
// @napi-rs/canvas does the equivalent in ~30ms in-process (~50-80x faster).

// Lazily loaded: the native binding is ~80ms of every harness-host boot, and
// most turns never return an oversized image. See canvas-lazy.ts.
import { loadCanvasModule } from "./canvas-lazy.js";
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

/** The resizer contract (canvas by default) — injectable for tests. */
export type ImageResizer = (
  bytes: Uint8Array,
  mimeType: string,
  options: { maxWidth: number; maxHeight: number; maxBytes: number },
) => Promise<{ data: string; mimeType: string } | null>;

/**
 * In-process resizer (the production default): decode with @napi-rs/canvas, resize
 * to fit within maxWidth/maxHeight (no enlargement), and re-encode JPEG, stepping
 * quality down until it fits maxBytes. ~30ms/image. Returns null on any failure or
 * an undecodable buffer, so the caller keeps the original.
 */
export const canvasResizer: ImageResizer = async (
  bytes,
  _mimeType,
  { maxWidth, maxHeight, maxBytes },
) => {
  try {
    const { createCanvas, loadImage } = await loadCanvasModule();
    const image = await loadImage(Buffer.from(bytes));
    if (!image.width || !image.height) {
      return null;
    }
    const maxDim = Math.max(1, Math.min(maxWidth, maxHeight));
    const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    // Step quality down until the encoded image fits the byte budget; keep the
    // lowest-quality attempt if none fit (still far smaller than a full-res PNG).
    let encoded = canvas.toBuffer("image/jpeg", 0.85);
    for (const quality of [0.75, 0.65, 0.5]) {
      if (encoded.length <= maxBytes) {
        break;
      }
      encoded = canvas.toBuffer("image/jpeg", quality);
    }
    return { data: encoded.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
};

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
 * `resize` is injectable purely for tests; production uses `canvasResizer`.
 */
export async function capToolResultImages<T>(
  content: T[],
  opts: ToolImageCapOptions = defaultOptions(),
  resize: ImageResizer = canvasResizer,
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
  resize: ImageResizer = canvasResizer,
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
