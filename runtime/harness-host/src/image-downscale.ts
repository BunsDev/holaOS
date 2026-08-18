// Lazily loaded — see canvas-lazy.ts (~80ms off every turn's TTFT).
import { loadCanvasModule } from "./canvas-lazy.js";

// Match the model's own high-res ceiling: current-gen vision (Opus 4.7/4.8,
// Fable 5) downsizes images to a ~2576px long edge (older models to 1568px), so
// capping here at 2576 preserves all the detail the model can use and lets it
// resize further itself when it can't — while still re-encoding to JPEG, which
// shrinks a screenshot 5-10x versus PNG. Resizing BELOW the model's ceiling is
// what blurs small text (numbers, fine print) in dense screenshots, so keep the
// cap high; the JPEG re-encode is the cheap part of the win. All three knobs are
// env-tunable so this can be dialed without a rebuild.
export const DEFAULT_MAX_IMAGE_DIMENSION = 2576;
export const DEFAULT_DOWNSCALE_TRIGGER_BYTES = 512 * 1024;
export const DEFAULT_JPEG_QUALITY = 0.85;

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface DownscaleInlineImageOptions {
  /** Long-edge pixel cap. Larger images are scaled down proportionally. */
  maxDimension?: number;
  /** Base64 length below which the image is left untouched (skip decode cost). */
  triggerBytes?: number;
  /** JPEG quality (0-1). */
  quality?: number;
}

export interface DownscaledImage {
  /** Base64 (no `data:` prefix). */
  data: string;
  /** Always `image/jpeg` for a re-encoded image. */
  mimeType: string;
}

/**
 * Downscale a single inline image (base64) so it is cheap to keep in the model
 * context: cap the long edge at `maxDimension` and re-encode to JPEG. Full-res
 * screenshots and read-in PNGs are the offenders — a handful in one turn pushes
 * the provider request past its ~30MB size ceiling (413 request_too_large). Run
 * at the tool-result source, this keeps even a single image-heavy turn's
 * internal LLM calls under the limit. Best-effort: returns null (keep the
 * original) when the image is already small, cannot be decoded, or would not
 * actually shrink.
 */
export async function downscaleInlineImage(
  base64: string,
  options: DownscaleInlineImageOptions = {},
): Promise<DownscaledImage | null> {
  const triggerBytes =
    options.triggerBytes ??
    envPositiveNumber(
      "HOLABOSS_IMAGE_DOWNSCALE_TRIGGER_BYTES",
      DEFAULT_DOWNSCALE_TRIGGER_BYTES,
    );
  if (typeof base64 !== "string" || base64.length <= triggerBytes) {
    return null;
  }
  try {
    const source = Buffer.from(base64, "base64");
    const { createCanvas, loadImage } = await loadCanvasModule();
    const image = await loadImage(source);
    const width = image.width;
    const height = image.height;
    if (!width || !height) {
      return null;
    }
    const maxDimension =
      options.maxDimension ??
      envPositiveNumber(
        "HOLABOSS_IMAGE_DOWNSCALE_MAX_DIM",
        DEFAULT_MAX_IMAGE_DIMENSION,
      );
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(targetWidth, targetHeight);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const encoded = canvas.toBuffer(
      "image/jpeg",
      options.quality ??
        envPositiveNumber("HOLABOSS_IMAGE_DOWNSCALE_QUALITY", DEFAULT_JPEG_QUALITY),
    );
    const encodedBase64 = encoded.toString("base64");
    // Keep the original if the re-encode did not actually save bytes (e.g. an
    // already-optimized small-dimension JPEG).
    if (encodedBase64.length >= base64.length) {
      return null;
    }
    return { data: encodedBase64, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
