import assert from "node:assert/strict";
import test from "node:test";

import { TRY_ON_CLIENT_EVENTS, parseTryOnClientEvent } from "../../src/commerce/try-on-client-events.ts";

test("every named event parses, except a feedback without a rating", () => {
  for (const event of TRY_ON_CLIENT_EVENTS) {
    const parsed = parseTryOnClientEvent({ event, rating: "up" });
    assert.equal(parsed?.event, event);
  }
  assert.equal(parseTryOnClientEvent({ event: "feedback" }), null);
});

test("only the closed fields survive; anything else has nowhere to travel", () => {
  const parsed = parseTryOnClientEvent({
    event: "result_error",
    productSlug: "vay-hoa",
    reason: "TIMEOUT",
    source: "nowhere",
    imageBase64: "AAAA",
    fileName: "me.jpg",
    note: "free text",
  });
  assert.deepEqual(parsed, { event: "result_error", productSlug: "vay-hoa", reason: "TIMEOUT" });
});

test("unknown events, non-objects and malformed slugs are refused or dropped", () => {
  for (const value of [null, undefined, "open", 3, [], { event: "hack" }, { event: 1 }]) {
    assert.equal(parseTryOnClientEvent(value), null);
  }
  assert.equal(parseTryOnClientEvent({ event: "open", productSlug: "Bad Slug" })?.productSlug, undefined);
  assert.equal(parseTryOnClientEvent({ event: "open", productSlug: "a".repeat(201) })?.productSlug, undefined);
});
