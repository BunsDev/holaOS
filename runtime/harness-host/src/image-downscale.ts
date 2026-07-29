import { createCanvas, loadImage } from "@napi-rs/canvas";

// Anthropic (and most providers) already downsize images whose long edge exceeds
// ~1568px, so carrying anything larger buys no quality — only cost. Re-encoding a
// screenshot to JPEG shrinks it 5-10x versus PNG, which is where most of the win
// comes from even when the dimensions are already within bounds.
export const DEFAULT_MAX_IMAGE_DIMENSION = 1568;
export const DEFAULT_DOWNSCALE_TRIGGER_BYTES = 512 * 1024;
export const DEFAULT_JPEG_QUALITY = 0.8;

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
  const triggerBytes = options.triggerBytes ?? DEFAULT_DOWNSCALE_TRIGGER_BYTES;
  if (typeof base64 !== "string" || base64.length <= triggerBytes) {
    return null;
  }
  try {
    const source = Buffer.from(base64, "base64");
    const image = await loadImage(source);
    const width = image.width;
    const height = image.height;
    if (!width || !height) {
      return null;
    }
    const maxDimension = options.maxDimension ?? DEFAULT_MAX_IMAGE_DIMENSION;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(targetWidth, targetHeight);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const encoded = canvas.toBuffer(
      "image/jpeg",
      options.quality ?? DEFAULT_JPEG_QUALITY,
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
