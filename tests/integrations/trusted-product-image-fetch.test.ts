import assert from "node:assert/strict";
import test from "node:test";

import { fetchTrustedProductImage } from "../../src/integrations/vertex-try-on/product-image.ts";
import { TRY_ON_MAX_IMAGE_BYTES } from "../../src/commerce/try-on-policy.ts";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../support/try-on-fixtures.ts";

const URL_OK = "https://content.pancake.vn/images/1/2/3/dress.jpg";

function fetcher(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

test("fetches the exact trusted URL over HTTPS without following redirects blindly", async () => {
  const { fn, calls } = fetcher(new Response(JPEG_BYTES, { status: 200 }));
  const result = await fetchTrustedProductImage(URL_OK, { fetch: fn });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/jpeg");
    assert.deepEqual([...result.image.bytes], [...JPEG_BYTES]);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, URL_OK);
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.credentials, undefined);
});

test("a URL outside the trusted-media contract is refused before any network call", async () => {
  for (const url of [
    "http://content.pancake.vn/images/1/2/3/dress.jpg",
    "https://evil.example/images/1/2/3/dress.jpg",
    "https://content.pancake.vn@evil.example/images/1/2/3/dress.jpg",
    "https://169.254.169.254/latest/meta-data",
    "https://content.pancake.vn/images/1/2/3/dress.webp.exe",
    "file:///etc/passwd",
  ]) {
    const { fn, calls } = fetcher();
    assert.deepEqual(await fetchTrustedProductImage(url, { fetch: fn }), {
      ok: false,
      reason: "UNTRUSTED_URL",
    });
    assert.equal(calls.length, 0, url);
  }
});

test("a redirect inside the trusted boundary is followed; one outside it is refused", async () => {
  const inside = fetcher(
    new Response(null, { status: 302, headers: { location: "https://cdn.pancake.vn/2/2023/5/13/abc.jpg" } }),
    new Response(PNG_BYTES, { status: 200 }),
  );
  const followed = await fetchTrustedProductImage(URL_OK, { fetch: inside.fn });
  assert.equal(followed.ok, true);
  assert.equal(inside.calls[1]!.url, "https://cdn.pancake.vn/2/2023/5/13/abc.jpg");

  for (const location of [
    "https://evil.example/a.jpg",
    "http://content.pancake.vn/images/1/2/3/a.jpg",
    "/relative/path.jpg",
  ]) {
    const outside = fetcher(new Response(null, { status: 302, headers: { location } }));
    assert.deepEqual(await fetchTrustedProductImage(URL_OK, { fetch: outside.fn }), {
      ok: false,
      reason: "FETCH_FAILED",
    });
    assert.equal(outside.calls.length, 1, location);
  }
});

test("a redirect loop is bounded", async () => {
  const hop = () => new Response(null, { status: 302, headers: { location: URL_OK } });
  const { fn, calls } = fetcher(hop(), hop(), hop(), hop(), hop());
  assert.deepEqual(await fetchTrustedProductImage(URL_OK, { fetch: fn }), {
    ok: false,
    reason: "FETCH_FAILED",
  });
  assert.ok(calls.length <= 3);
});

test("a product image over 7 MB fails safely: by Content-Length and by streamed size", async () => {
  const declared = fetcher(
    new Response(JPEG_BYTES, {
      status: 200,
      headers: { "content-length": String(TRY_ON_MAX_IMAGE_BYTES + 1) },
    }),
  );
  assert.deepEqual(await fetchTrustedProductImage(URL_OK, { fetch: declared.fn }), {
    ok: false,
    reason: "TOO_LARGE",
  });

  const big = new Uint8Array(TRY_ON_MAX_IMAGE_BYTES + 1);
  big.set(JPEG_BYTES);
  const streamed = fetcher(new Response(big, { status: 200 }));
  assert.deepEqual(await fetchTrustedProductImage(URL_OK, { fetch: streamed.fn }), {
    ok: false,
    reason: "TOO_LARGE",
  });

  const exact = new Uint8Array(TRY_ON_MAX_IMAGE_BYTES);
  exact.set(JPEG_BYTES);
  assert.equal(
    (await fetchTrustedProductImage(URL_OK, { fetch: fetcher(new Response(exact)).fn })).ok,
    true,
  );
});

test("a non-image body, a WebP body, or a non-200 status fails", async () => {
  for (const response of [
    new Response(WEBP_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } }),
    new Response("<html></html>", { status: 200, headers: { "content-type": "image/jpeg" } }),
    new Response(JPEG_BYTES, { status: 404 }),
    new Response(JPEG_BYTES, { status: 500 }),
    new Response(new Uint8Array(0), { status: 200 }),
  ]) {
    const result = await fetchTrustedProductImage(URL_OK, { fetch: fetcher(response).fn });
    assert.equal(result.ok, false);
  }
});

test("a network error or timeout fails safely", async () => {
  assert.deepEqual(
    await fetchTrustedProductImage(URL_OK, { fetch: fetcher(new TypeError("fetch failed")).fn }),
    { ok: false, reason: "FETCH_FAILED" },
  );

  const hang = async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  assert.deepEqual(await fetchTrustedProductImage(URL_OK, { fetch: hang, timeoutMs: 20 }), {
    ok: false,
    reason: "FETCH_FAILED",
  });
});
