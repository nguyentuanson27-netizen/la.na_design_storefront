import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginUpsellRequest, readCheckoutUpsellProof, MAX_UPSELL_REQUEST_BYTES } from "../../src/commerce/checkout-upsell-http.ts";

function request(body: string, origin = "https://store.example") {
  return new Request("https://store.example/api/checkout/upsell", {
    method: "POST",
    headers: { origin, "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" },
    body,
  });
}

test("upsell read requires a same-origin POST even when browser cookies would be attached", () => {
  assert.equal(isSameOriginUpsellRequest(new Request("https://store.example/api/checkout/upsell", { headers: { origin: "https://store.example" } }), "https://store.example"), false);
  assert.equal(isSameOriginUpsellRequest(request("{}"), "https://store.example"), true);
  assert.equal(isSameOriginUpsellRequest(request("{}", "https://evil.example"), "https://store.example"), false);
  assert.equal(isSameOriginUpsellRequest(request("{}"), "https://other.example"), false, "never trust the request Host over configured origin");
  assert.equal(isSameOriginUpsellRequest(new Request("https://store.example/api/checkout/upsell", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), "https://store.example"), false);
  assert.equal(isSameOriginUpsellRequest(new Request("https://store.example/api/checkout/upsell", {
    method: "POST", headers: { origin: "https://store.example", "sec-fetch-site": "cross-site" }, body: "{}",
  }), "https://store.example"), false);
});

test("upsell request accepts only one bounded quote proof, never cart ids or client prices", async () => {
  assert.equal(await readCheckoutUpsellProof(request(JSON.stringify({ quoteProof: "abc.def" }))), "abc.def");
  assert.equal(await readCheckoutUpsellProof(request(JSON.stringify({ quoteProof: "abc.def", cartId: "fake" }))), null);
  assert.equal(await readCheckoutUpsellProof(request(JSON.stringify({ quoteProof: "not a signed proof" }))), null);
  assert.equal(await readCheckoutUpsellProof(request(JSON.stringify({ quoteProof: 42 }))), null);
  assert.equal(await readCheckoutUpsellProof(request("{bad json")), null);
  assert.equal(await readCheckoutUpsellProof(request(JSON.stringify({ quoteProof: "a".repeat(MAX_UPSELL_REQUEST_BYTES) }))), null);
});

test("upsell read rejects non-json media types and content-length over the byte budget", async () => {
  assert.equal(await readCheckoutUpsellProof(new Request("https://store.example/api/checkout/upsell", {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ quoteProof: "abc.def" }),
  })), null);
  assert.equal(await readCheckoutUpsellProof(new Request("https://store.example/api/checkout/upsell", {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_UPSELL_REQUEST_BYTES + 1) },
    body: JSON.stringify({ quoteProof: "abc.def" }),
  })), null);
});

test("an unfinished body cannot occupy an upsell slot forever, even if cancellation never resolves", { timeout: 4000 }, async () => {
  let cancellationRequested = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"quoteProof":"abc.def"'));
      // The client keeps the connection open without finishing the JSON.
    },
    cancel() {
      cancellationRequested = true;
      return new Promise<void>(() => {}); // an uncooperative stream
    },
  });
  const stalled = new Request("https://store.example/api/checkout/upsell", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const started = Date.now();
  assert.equal(await readCheckoutUpsellProof(stalled), null);
  assert.equal(cancellationRequested, true);
  assert.ok(Date.now() - started < 3000, "the deadline must release the body-read slot promptly");
});

test("oversized streaming bodies fail without awaiting a stuck cancel handler", { timeout: 4000 }, async () => {
  let cancellationRequested = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_UPSELL_REQUEST_BYTES + 1)); },
    cancel() {
      cancellationRequested = true;
      return new Promise<void>(() => {});
    },
  });
  const oversized = new Request("https://store.example/api/checkout/upsell", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const started = Date.now();
  assert.equal(await readCheckoutUpsellProof(oversized), null);
  assert.equal(cancellationRequested, true);
  assert.ok(Date.now() - started < 3000, "rejecting an oversized body must not wait on cancellation");
});
