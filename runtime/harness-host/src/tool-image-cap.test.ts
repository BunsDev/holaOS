import assert from "node:assert/strict";
import test from "node:test";

import {
  capToolResultImages,
  wrapToolWithImageCap,
  type ImageResizer,
  type ToolImageCapOptions,
} from "./tool-image-cap.js";

const OPTS: ToolImageCapOptions = {
  maxDim: 2576,
  maxBytes: 1_500_000,
  triggerBytes: 1000,
};

// Fake resizer: pretends to shrink any image to a tiny JPEG — tests the wiring
// without decoding real bytes / spinning the Photon worker.
const shrink: ImageResizer = async () => ({
  data: "y".repeat(100),
  mimeType: "image/jpeg",
});

function image(len: number, mime = "image/png") {
  return { type: "image" as const, data: "x".repeat(len), mimeType: mime };
}
function text(t: string) {
  return { type: "text" as const, text: t };
}

test("capToolResultImages downscales an oversized image, leaves text alone", async () => {
  const content = [text("hi"), image(5000)];
  const out = await capToolResultImages(content, OPTS, shrink);
  assert.notEqual(out, content);
  assert.deepEqual(out[0], text("hi"));
  const img = out[1] as { type: string; data: string; mimeType: string } | undefined;
  assert.ok(img);
  assert.equal(img.mimeType, "image/jpeg");
  assert.ok(img.data.length < 5000);
});

test("capToolResultImages leaves small images untouched (same ref)", async () => {
  const content = [image(50)];
  assert.equal(await capToolResultImages(content, OPTS, shrink), content);
});

test("capToolResultImages keeps original when resizer returns null or bigger", async () => {
  const nullR: ImageResizer = async () => null;
  const bigR: ImageResizer = async () => ({ data: "z".repeat(999999), mimeType: "image/jpeg" });
  const content = [image(5000)];
  assert.equal(await capToolResultImages(content, OPTS, nullR), content);
  assert.equal(await capToolResultImages(content, OPTS, bigR), content);
});

test("REGRESSION: a burst of full-res images in one tool result all shrink", async () => {
  const content = Array.from({ length: 8 }, () => image(4_000_000));
  const before = content.reduce((n, b) => n + b.data.length, 0);
  const out = await capToolResultImages(content, OPTS, shrink);
  const after = out.reduce((n, b) => n + (b as { data: string }).data.length, 0);
  assert.ok(before > 30_000_000);
  assert.ok(after < 100_000, `capped batch is tiny (${after}B)`);
});

test("wrapToolWithImageCap downscales images in a tool's result", async () => {
  const tool = {
    name: "generate_image",
    execute: async () => ({
      content: [text("done"), image(5000)],
      details: { ok: true },
    }),
  } as unknown as Parameters<typeof wrapToolWithImageCap>[0];
  const wrapped = wrapToolWithImageCap(tool, OPTS, shrink);
  const result = (await wrapped.execute(
    "c",
    {},
    undefined,
    undefined,
    undefined as never,
  )) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
  const first = result.content[0];
  const second = result.content[1];
  assert.ok(first && second);
  assert.equal(first.text, "done");
  assert.equal(second.type, "image");
  assert.equal(second.mimeType, "image/jpeg");
  assert.ok((second.data ?? "").length < 5000);
});

test("wrapToolWithImageCap passes image-free results through by identity", async () => {
  const payload = { content: [text("no images")], details: {} };
  const tool = { name: "bash", execute: async () => payload } as unknown as Parameters<
    typeof wrapToolWithImageCap
  >[0];
  const wrapped = wrapToolWithImageCap(tool, OPTS, shrink);
  assert.equal(await wrapped.execute("c", {}, undefined, undefined, undefined as never), payload);
});
