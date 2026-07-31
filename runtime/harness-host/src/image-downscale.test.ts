import assert from "node:assert/strict";
import test from "node:test";

import { createCanvas } from "@napi-rs/canvas";

import { downscaleInlineImage } from "./image-downscale.js";
import { wrapToolWithImageDownscale } from "./pi.js";

/**
 * Build a large, noisy PNG whose base64 comfortably exceeds the downscale
 * trigger. Random per-pixel colour defeats PNG compression so the encoded buffer
 * is genuinely big (a flat fill would compress to a few KB and be skipped).
 */
function bigPngBase64(size = 1024): string {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  // Per-pixel PRNG noise defeats PNG compression, so the encoded buffer is
  // genuinely large (a smooth pattern would compress to a few KB and be skipped).
  let seed = 0x12345678;
  const nextByte = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = nextByte();
    imageData.data[i + 1] = nextByte();
    imageData.data[i + 2] = nextByte();
    imageData.data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer("image/png").toString("base64");
}

test("downscaleInlineImage shrinks a large PNG and re-encodes to JPEG", async () => {
  const original = bigPngBase64(1400);
  assert.ok(original.length > 512 * 1024, "fixture should exceed the trigger");
  const result = await downscaleInlineImage(original);
  assert.ok(result, "a large image should be downscaled");
  assert.equal(result?.mimeType, "image/jpeg");
  assert.ok(
    (result?.data.length ?? Infinity) < original.length,
    "downscaled image must be smaller",
  );
});

test("downscaleInlineImage caps the long edge at maxDimension", async () => {
  const original = bigPngBase64(1400);
  const result = await downscaleInlineImage(original, { maxDimension: 256 });
  assert.ok(result);
  // Decode the result back and check its dimensions were clamped.
  const { loadImage } = await import("@napi-rs/canvas");
  const decoded = await loadImage(Buffer.from(result!.data, "base64"));
  assert.ok(Math.max(decoded.width, decoded.height) <= 256);
});

test("downscaleInlineImage leaves small images untouched (returns null)", async () => {
  const small = Buffer.from("hello").toString("base64");
  assert.equal(await downscaleInlineImage(small), null);
});

test("downscaleInlineImage returns null on undecodable data", async () => {
  const garbage = "x".repeat(600 * 1024); // over trigger, not a real image
  assert.equal(await downscaleInlineImage(garbage), null);
});

test("wrapToolWithImageDownscale downscales image blocks in a tool result", async () => {
  const original = bigPngBase64(1400);
  const tool = {
    name: "read",
    execute: async () => ({
      content: [
        { type: "text", text: "here is the image" },
        { type: "image", data: original, mimeType: "image/png" },
      ],
      details: {},
    }),
  };
  const wrapped = wrapToolWithImageDownscale(tool);
  const result = (await wrapped.execute()) as {
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
  };
  // Text block untouched.
  assert.equal(result.content[0].text, "here is the image");
  // Image block downscaled + re-encoded.
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.ok((result.content[1].data?.length ?? Infinity) < original.length);
});

test("REGRESSION (diagnostics 2026-07-29): a single turn that reads many full-res images stays tiny after source downscaling", async () => {
  // The original in-turn failure: the agent read 7 full-res 1200x1200 PNGs in one
  // turn, and the combined inline size blew past the provider's ~30MB ceiling
  // mid-loop (413). Downscaling at the tool-result source must collapse each so
  // the whole batch is a small fraction of the ceiling.
  const readImageTool = {
    name: "read",
    execute: async (path: string) => ({
      content: [{ type: "image", data: bigPngBase64(1400), mimeType: "image/png" }],
      details: { path },
    }),
  };
  const wrapped = wrapToolWithImageDownscale(readImageTool);

  let combinedBefore = 0;
  let combinedAfter = 0;
  for (let i = 0; i < 7; i += 1) {
    const raw = (await readImageTool.execute(`img-${i}.png`)) as {
      content: Array<{ data: string }>;
    };
    combinedBefore += raw.content[0].data.length;
    const out = (await wrapped.execute(`img-${i}.png`)) as {
      content: Array<{ data: string }>;
    };
    combinedAfter += out.content[0].data.length;
  }

  assert.ok(combinedAfter < combinedBefore, "downscaling must shrink the batch");
  assert.ok(
    combinedAfter < 5 * 1024 * 1024,
    `7 downscaled images (${combinedAfter}B) must be well under the provider ceiling`,
  );
});

test("wrapToolWithImageDownscale passes through results without images", async () => {
  const payload = { content: [{ type: "text", text: "no images here" }], details: {} };
  const tool = { name: "bash", execute: async () => payload };
  const wrapped = wrapToolWithImageDownscale(tool);
  const result = await wrapped.execute();
  assert.equal(result, payload, "unchanged results should pass through by identity");
});
