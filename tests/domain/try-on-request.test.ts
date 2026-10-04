import assert from "node:assert/strict";
import test from "node:test";

import { sniffImageMime, readBoundedBody } from "../../src/commerce/try-on-image.ts";
import { TRY_ON_MAX_IMAGE_BYTES } from "../../src/commerce/try-on-policy.ts";
import { parseTryOnRequest } from "../../src/commerce/try-on-request.ts";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES, tryOnForm } from "../support/try-on-fixtures.ts";

test("sniffImageMime recognises JPEG and PNG signatures only", () => {
  assert.equal(sniffImageMime(JPEG_BYTES), "image/jpeg");
  assert.equal(sniffImageMime(PNG_BYTES), "image/png");
  assert.equal(sniffImageMime(WEBP_BYTES), null);
  assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null);
  assert.equal(sniffImageMime(new Uint8Array()), null);
});

test("readBoundedBody returns the bytes within the limit and null beyond it", async () => {
  const within = await readBoundedBody(new Response(new Uint8Array(10)).body, 10);
  assert.equal(within?.byteLength, 10);
  const beyond = await readBoundedBody(new Response(new Uint8Array(11)).body, 10);
  assert.equal(beyond, null);
  assert.equal((await readBoundedBody(null, 10))?.byteLength, 0);
});

test("a valid request parses to the slug, age state and photo bytes", async () => {
  const result = await parseTryOnRequest(tryOnForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.productSlug, "vay-hoa");
  assert.equal(result.value.ageState, "adult");
  assert.equal(result.value.photo.mimeType, "image/jpeg");
  assert.deepEqual([...result.value.photo.bytes], [...JPEG_BYTES]);
});

test("a PNG upload with a PNG declared type is accepted", async () => {
  const result = await parseTryOnRequest(
    tryOnForm({ photo: new File([PNG_BYTES], "me.png", { type: "image/png" }) }),
  );
  assert.equal(result.ok, true);
});

test("the likeness acknowledgement is required, exactly 'true'", async () => {
  for (const likenessAcknowledged of [null, "", "false", "1", "yes", "TRUE"]) {
    const result = await parseTryOnRequest(tryOnForm({ likenessAcknowledged }));
    assert.deepEqual(result, { ok: false, reason: "LIKENESS_REQUIRED" }, String(likenessAcknowledged));
  }
});

test("a missing or unknown age state is rejected", async () => {
  for (const ageState of [null, "", "child", "ADULT", "adult,adult"]) {
    const result = await parseTryOnRequest(tryOnForm({ ageState }));
    assert.deepEqual(result, { ok: false, reason: "AGE_STATE_INVALID" }, String(ageState));
  }
});

test("teen_eligible_with_guardian is allowed and below_digital_consent_age is blocked", async () => {
  assert.equal((await parseTryOnRequest(tryOnForm({ ageState: "teen_eligible_with_guardian" }))).ok, true);
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ ageState: "below_digital_consent_age" })), {
    ok: false,
    reason: "AGE_BLOCKED",
  });
});

test("gates run before the photo is read, so a blocked age with a bad photo reports the age", async () => {
  const result = await parseTryOnRequest(
    tryOnForm({ ageState: "below_digital_consent_age", photo: null }),
  );
  assert.deepEqual(result, { ok: false, reason: "AGE_BLOCKED" });
});

test("exactly one photo is required", async () => {
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ photo: null })), {
    ok: false,
    reason: "UNSUPPORTED_IMAGE",
  });
  const two = [
    new File([JPEG_BYTES], "a.jpg", { type: "image/jpeg" }),
    new File([JPEG_BYTES], "b.jpg", { type: "image/jpeg" }),
  ];
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ photo: two })), {
    ok: false,
    reason: "UNSUPPORTED_IMAGE",
  });
});

test("a text field in place of the file is rejected", async () => {
  const form = tryOnForm({ photo: null });
  form.append("photo", "not-a-file");
  assert.deepEqual(await parseTryOnRequest(form), { ok: false, reason: "UNSUPPORTED_IMAGE" });
});

test("unsupported shopper MIME types are rejected", async () => {
  for (const [bytes, type] of [
    [WEBP_BYTES, "image/webp"],
    [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), "image/gif"],
    [JPEG_BYTES, "application/pdf"],
    [JPEG_BYTES, ""],
  ] as const) {
    const result = await parseTryOnRequest(tryOnForm({ photo: new File([bytes], "x", { type }) }));
    assert.deepEqual(result, { ok: false, reason: "UNSUPPORTED_IMAGE" }, type);
  }
});

test("a forged MIME type is rejected by signature validation", async () => {
  const webpAsJpeg = new File([WEBP_BYTES], "x.jpg", { type: "image/jpeg" });
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ photo: webpAsJpeg })), {
    ok: false,
    reason: "UNSUPPORTED_IMAGE",
  });
  const pngAsJpeg = new File([PNG_BYTES], "x.jpg", { type: "image/jpeg" });
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ photo: pngAsJpeg })), {
    ok: false,
    reason: "UNSUPPORTED_IMAGE",
  });
});

test("an empty file is rejected", async () => {
  const empty = new File([], "x.jpg", { type: "image/jpeg" });
  assert.deepEqual(await parseTryOnRequest(tryOnForm({ photo: empty })), {
    ok: false,
    reason: "UNSUPPORTED_IMAGE",
  });
});

test("a shopper image over 7 MB is rejected; exactly 7 MB is accepted", async () => {
  const header = [...JPEG_BYTES];
  const atLimit = new Uint8Array(TRY_ON_MAX_IMAGE_BYTES);
  atLimit.set(header);
  assert.equal(
    (await parseTryOnRequest(tryOnForm({ photo: new File([atLimit], "x.jpg", { type: "image/jpeg" }) }))).ok,
    true,
  );
  const over = new Uint8Array(TRY_ON_MAX_IMAGE_BYTES + 1);
  over.set(header);
  assert.deepEqual(
    await parseTryOnRequest(tryOnForm({ photo: new File([over], "x.jpg", { type: "image/jpeg" }) })),
    { ok: false, reason: "IMAGE_TOO_LARGE" },
  );
});

test("a missing or malformed product slug is rejected", async () => {
  for (const productSlug of [null, "", "x".repeat(201)]) {
    assert.deepEqual(await parseTryOnRequest(tryOnForm({ productSlug })), {
      ok: false,
      reason: "INVALID_REQUEST",
    });
  }
});

test("a client-supplied product image URL is never part of the parsed request", async () => {
  const result = await parseTryOnRequest(
    tryOnForm({
      extra: {
        productImageUrl: "https://evil.example/steal.jpg",
        productImage: "http://169.254.169.254/latest/meta-data",
        imageUrl: "https://content.pancake.vn/images/1/2/3/other.jpg",
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value).sort(), ["ageState", "photo", "productSlug"]);
  assert.doesNotMatch(JSON.stringify(result.value), /evil\.example|169\.254|other\.jpg/);
});
