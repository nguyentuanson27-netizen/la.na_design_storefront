import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  TRY_ON_RESULT_MAX_EDGE,
  compressTryOnResult,
} from "../../src/integrations/try-on/result-image.ts";
import { PNG_BYTES } from "../support/try-on-fixtures.ts";

/** A smooth gradient with mild sensor-like noise: big as a PNG, small as a JPEG, like a photograph. */
async function noisyPng(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  const noise = randomBytes(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const pixel = Math.floor(index / 3);
    const base = ((pixel % width) / width) * 120 + (Math.floor(pixel / width) / height) * 100;
    raw[index] = Math.min(255, Math.round(base) + (noise[index]! & 15));
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

test("a 2K PNG becomes a much smaller JPEG no larger than the result edge", async () => {
  const original = await noisyPng(1536, 2048);
  const result = await compressTryOnResult({ bytes: original, mimeType: "image/png" });
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.bytes.byteLength < original.byteLength / 2);
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), TRY_ON_RESULT_MAX_EDGE);
  // Proportions are kept.
  assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 0.75) < 0.01);
});

test("a picture already small is never enlarged", async () => {
  const original = await noisyPng(400, 600);
  const result = await compressTryOnResult({ bytes: original, mimeType: "image/png" });
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 600);
});

test("bytes that are not a decodable image come back unchanged", async () => {
  const image = { bytes: PNG_BYTES, mimeType: "image/png" } as const;
  assert.equal(await compressTryOnResult(image), image);
});
