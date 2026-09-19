import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RENDERED_QUOTE_PROOF_BYTES,
  issueRenderedQuoteProof,
  verifyRenderedQuoteProof,
  type RenderedQuoteProofFacts,
} from "../../src/commerce/checkout-quote-proof.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "../../src/commerce/anonymous-cart.ts";

const secret = "test-server-secret-at-least-32-characters-long";
const otherSecret = "another-server-secret-at-least-32-characters-long";
const cartId = "0f8d3c2a-4b1e-4d7a-9c6b-2e5f1a8d4c30";
const otherCartId = "9a1b7c6d-3e2f-4a5b-8c9d-1e2f3a4b5c6d";

const quote: RenderedQuoteProofFacts = {
  items: [
    { variantExternalId: "var-b", quantity: 2, unitPriceVnd: 400_000, fulfillmentState: "READY" as const },
    { variantExternalId: "var-a", quantity: 1, unitPriceVnd: 650_000, fulfillmentState: "READY" as const },
  ],
  merchandiseSubtotalVnd: 1_450_000,
  shippingFeeVnd: 30_000,
  totalVnd: 1_480_000,
  totalQuantity: 3,
};

/** Issues and asserts a token was produced, for the cases that are not about the size bound. */
function issue(overrides: Partial<Parameters<typeof issueRenderedQuoteProof>[0]> = {}): string {
  const proof = issueRenderedQuoteProof({ quote, cartId, secret, ...overrides });
  assert.ok(proof, "expected these facts to produce a proof");
  return proof;
}

function verify(overrides: Partial<Parameters<typeof verifyRenderedQuoteProof>[0]> = {}) {
  return verifyRenderedQuoteProof({
    proof: issue(),
    cartId,
    currentQuote: quote,
    secret,
    ...overrides,
  });
}

test("P9a a proof issued for the current quote and cart verifies", () => {
  assert.deepEqual(verify(), { ok: true });
});

test("P9a canonicalization is deterministic and order-independent", () => {
  assert.equal(issue(), issue(), "same facts must produce identical proof bytes");

  const reordered = {
    ...quote,
    items: [...quote.items].reverse(),
  };
  assert.equal(
    issue({ quote: reordered }),
    issue(),
    "item order must not change the canonical payload",
  );
});

test("P9a the proof is ASCII base64url and carries a format/version fact", () => {
  const proof = issue();
  assert.match(proof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8");
  // Bumped to `laq2` by F8b, which added each line's fulfillment state to the signed facts. The
  // version is pinned here on purpose: changing what a proof means without changing what it is
  // called would let a token issued under the old meaning be redeemed under the new one.
  assert.match(payload, /^laq2\|/, "payload must open with the format/version fact");
});

test("P9a browser-visible proof bytes never carry the raw HttpOnly cart id", () => {
  const proof = issue();
  assert.equal(proof.includes(cartId), false);

  const payload = Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8");
  assert.equal(payload.includes(cartId), false, "decoded payload must not leak the cart UUID");
  assert.equal(payload.includes(cartId.replace(/-/g, "")), false);
  // The quote facts the payload is allowed to carry are still all present.
  assert.equal(payload.includes("var-a"), true);
  assert.equal(payload.includes("650000"), true);
});

test("P9a a proof bound to another cart fails closed", () => {
  assert.deepEqual(verify({ cartId: otherCartId }), {
    ok: false,
    reason: "PROOF_UNVERIFIED",
  });
});

test("P9a a proof signed with another server secret fails closed", () => {
  assert.deepEqual(verify({ proof: issue({ secret: otherSecret }) }), {
    ok: false,
    reason: "PROOF_UNVERIFIED",
  });
});

test("P9a a tampered payload fails closed rather than re-pricing", () => {
  const [payload64, mac64] = issue().split(".") as [string, string];
  const forged = Buffer.from(
    Buffer.from(payload64, "base64url").toString("utf8").replace("650000", "1"),
    "utf8",
  ).toString("base64url");

  assert.deepEqual(verify({ proof: `${forged}.${mac64}` }), {
    ok: false,
    reason: "PROOF_UNVERIFIED",
  });
});

test("P9a missing or non-string proof fails closed", () => {
  for (const proof of [undefined, null, "", 42, {}, []]) {
    assert.deepEqual(
      verify({ proof }),
      { ok: false, reason: "PROOF_MISSING" },
      `expected PROOF_MISSING for ${JSON.stringify(proof) ?? String(proof)}`,
    );
  }
});

test("P9a malformed proof shapes fail closed", () => {
  for (const proof of ["no-separator", "a.b.c", "!!!.???", ".", "abc.", ".abc"]) {
    const result = verify({ proof });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "PROOF_MALFORMED", `expected PROOF_MALFORMED for ${proof}`);
  }
});

test("P9a the byte ceiling accepts max and rejects max+1 before decode/MAC work", () => {
  assert.equal(MAX_RENDERED_QUOTE_PROOF_BYTES, 16 * 1024);

  const macPart = "B".repeat(43);
  const atMax = `${"A".repeat(MAX_RENDERED_QUOTE_PROOF_BYTES - 1 - macPart.length)}.${macPart}`;
  assert.equal(Buffer.byteLength(atMax, "utf8"), MAX_RENDERED_QUOTE_PROOF_BYTES);

  const atMaxResult = verify({ proof: atMax });
  assert.equal(atMaxResult.ok, false);
  if (atMaxResult.ok) return;
  assert.notEqual(
    atMaxResult.reason,
    "PROOF_OVERSIZED",
    "a proof at exactly the ceiling must reach normal verification",
  );

  assert.deepEqual(verify({ proof: `A${atMax}` }), {
    ok: false,
    reason: "PROOF_OVERSIZED",
  });
});

test("P9a the 16 KiB envelope genuinely fits a full 50-line cart", () => {
  // The spec sizes this bound against the current `ANONYMOUS_CART_MAX_DISTINCT_ITEMS`, so the claim
  // is measured rather than asserted in a comment. If the cart ceiling rises, this fails and the
  // envelope gets re-proven instead of being quietly raised.
  const items = Array.from({ length: ANONYMOUS_CART_MAX_DISTINCT_ITEMS }, (_unused, index) => ({
    // Deliberately generous: a UUID-shaped external id with room to spare over what Pancake mirrors.
    variantExternalId: `${String(index).padStart(4, "0")}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
    quantity: 999,
    unitPriceVnd: 999_999_999,
    fulfillmentState: "READY" as const,
  }));
  const full: RenderedQuoteProofFacts = {
    items,
    merchandiseSubtotalVnd: Number.MAX_SAFE_INTEGER - 1,
    shippingFeeVnd: 999_999,
    totalVnd: Number.MAX_SAFE_INTEGER,
    totalQuantity: 999 * ANONYMOUS_CART_MAX_DISTINCT_ITEMS,
  };

  const proof = issue({ quote: full });
  assert.ok(
    Buffer.byteLength(proof, "utf8") <= MAX_RENDERED_QUOTE_PROOF_BYTES,
    `a full cart must fit the envelope, got ${Buffer.byteLength(proof, "utf8")} bytes`,
  );
  assert.deepEqual(
    verifyRenderedQuoteProof({ proof, cartId, currentQuote: full, secret }),
    { ok: true },
  );
});

test("P9a issuing refuses a token the verifier could never accept", () => {
  // The accepted external-id domain is not UUID-shaped: `VariantMirror.pancakeVariationId` is an
  // unbounded column and the catalog contract only requires non-empty, so a long enough synced id
  // can push the token past the envelope. Issuing it anyway would hand the buyer a proof every
  // submission rejects as oversized — a reconfirm loop no retry escapes.
  const withIdLength = (length: number): RenderedQuoteProofFacts => ({
    items: [{ variantExternalId: "v".repeat(length), quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 100_000,
    shippingFeeVnd: 0,
    totalVnd: 100_000,
    totalQuantity: 1,
  });

  // Walk the real boundary rather than guessing it: the largest id this domain can still prove.
  let largestAccepted = 0;
  for (let length = 1; length <= MAX_RENDERED_QUOTE_PROOF_BYTES * 2; length += 1) {
    if (issueRenderedQuoteProof({ quote: withIdLength(length), cartId, secret }) === null) break;
    largestAccepted = length;
  }
  assert.ok(largestAccepted > 0, "some id length must be provable");

  const atMax = issueRenderedQuoteProof({ quote: withIdLength(largestAccepted), cartId, secret });
  assert.ok(atMax, "the largest accepted id must still produce a token");
  assert.ok(Buffer.byteLength(atMax, "utf8") <= MAX_RENDERED_QUOTE_PROOF_BYTES);
  assert.deepEqual(
    verifyRenderedQuoteProof({
      proof: atMax,
      cartId,
      currentQuote: withIdLength(largestAccepted),
      secret,
    }),
    { ok: true },
    "a token at the boundary must verify, not merely be issued",
  );

  // max+1 and beyond are refused at issue time, so no unverifiable token ever reaches a buyer.
  for (const overshoot of [1, 2, 64, 4096]) {
    assert.equal(
      issueRenderedQuoteProof({ quote: withIdLength(largestAccepted + overshoot), cartId, secret }),
      null,
      `an id ${overshoot} bytes past the boundary must be refused at issue time`,
    );
  }
});

test("P9a many oversized lines are refused at issue time too, not only one long id", () => {
  // The same bound has to hold when cardinality rather than a single id is what overflows it.
  const items = Array.from({ length: ANONYMOUS_CART_MAX_DISTINCT_ITEMS }, (_unused, index) => ({
    variantExternalId: `${index}-${"v".repeat(1_000)}`,
    quantity: 1,
    unitPriceVnd: 100_000,
    fulfillmentState: "READY" as const,
  }));
  assert.equal(
    issueRenderedQuoteProof({
      quote: {
        items,
        merchandiseSubtotalVnd: 100_000 * items.length,
        shippingFeeVnd: 0,
        totalVnd: 100_000 * items.length,
        totalQuantity: items.length,
      },
      cartId,
      secret,
    }),
    null,
  );
});

test("F8b a fulfillment state that moved between render and submit is not silently accepted", () => {
  // The exact §30 hazard: same items, same money, but the line has become a preorder sale between
  // the page the buyer read and the order they submitted. Without the state in the signed facts
  // this verified, and the order committed — and was snapshotted by I7 — as PREORDER against a
  // checkout that read as ready stock.
  const readyItems = [
    { variantExternalId: "var-a", quantity: 1, unitPriceVnd: 400_000, fulfillmentState: "READY" as const },
  ];
  const preorderItems = [
    { variantExternalId: "var-a", quantity: 1, unitPriceVnd: 400_000, fulfillmentState: "PREORDER" as const },
  ];

  assert.deepEqual(
    verifyRenderedQuoteProof({
      proof: issue({ quote: { ...quote, items: readyItems } }),
      cartId,
      currentQuote: { ...quote, items: preorderItems },
      secret,
    }),
    { ok: false, reason: "PRICE_CHANGED" },
  );

  // And the other direction, so this is a comparison rather than a one-way check.
  assert.deepEqual(
    verifyRenderedQuoteProof({
      proof: issue({ quote: { ...quote, items: preorderItems } }),
      cartId,
      currentQuote: { ...quote, items: readyItems },
      secret,
    }),
    { ok: false, reason: "PRICE_CHANGED" },
  );

  // An unchanged preorder basket still redeems: the gate is a change, not the state itself.
  assert.equal(
    verifyRenderedQuoteProof({
      proof: issue({ quote: { ...quote, items: preorderItems } }),
      cartId,
      currentQuote: { ...quote, items: preorderItems },
      secret,
    }).ok,
    true,
  );
});

test("P9a a stale proof reports PRICE_CHANGED against the current quote", () => {
  const staleProof = issue({
    quote: { ...quote, items: [{ variantExternalId: "var-a", quantity: 1, unitPriceVnd: 400_000, fulfillmentState: "READY" as const }] },
  });

  assert.deepEqual(
    verifyRenderedQuoteProof({
      proof: staleProof,
      cartId,
      currentQuote: {
        ...quote,
        items: [{ variantExternalId: "var-a", quantity: 1, unitPriceVnd: 500_000, fulfillmentState: "READY" as const }],
      },
      secret,
    }),
    { ok: false, reason: "PRICE_CHANGED" },
  );
});

test("P9a every quote fact is bound, so any single change invalidates the proof", () => {
  const proof = issue();
  const mutations: Array<[string, RenderedQuoteProofFacts]> = [
    ["unit price", { ...quote, items: [{ ...quote.items[0]! }, { ...quote.items[1]!, unitPriceVnd: 650_001 }] }],
    ["quantity", { ...quote, items: [{ ...quote.items[0]!, quantity: 3 }, { ...quote.items[1]! }] }],
    ["variant identity", { ...quote, items: [{ ...quote.items[0]! }, { ...quote.items[1]!, variantExternalId: "var-c" }] }],
    ["merchandise subtotal", { ...quote, merchandiseSubtotalVnd: 1_450_001 }],
    ["shipping fee", { ...quote, shippingFeeVnd: 0 }],
    ["total", { ...quote, totalVnd: 1_480_001 }],
    ["total quantity", { ...quote, totalQuantity: 4 }],
  ];

  for (const [label, currentQuote] of mutations) {
    assert.deepEqual(
      verifyRenderedQuoteProof({ proof, cartId, currentQuote, secret }),
      { ok: false, reason: "PRICE_CHANGED" },
      `changing the ${label} must invalidate the rendered proof`,
    );
  }
});

test("P9a a line count change cannot be smuggled past canonicalization", () => {
  const oneLine = {
    items: [{ variantExternalId: "var-a", quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 100_000,
    shippingFeeVnd: 0,
    totalVnd: 100_000,
    totalQuantity: 1,
  };
  const twoLines = {
    items: [
      { variantExternalId: "var-a", quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const },
      { variantExternalId: "var-b", quantity: 1, unitPriceVnd: 0o0 + 1, fulfillmentState: "READY" as const },
    ],
    merchandiseSubtotalVnd: 100_001,
    shippingFeeVnd: 0,
    totalVnd: 100_001,
    totalQuantity: 2,
  };

  assert.notEqual(
    issue({ quote: oneLine }),
    issue({ quote: twoLines }),
    "line cardinality must be part of the canonical payload",
  );
});

test("P9a variant ids containing the field delimiters cannot forge a different quote", () => {
  const injected = {
    items: [{ variantExternalId: "var-a:1:400000|1", quantity: 1, unitPriceVnd: 100_000, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 100_000,
    shippingFeeVnd: 0,
    totalVnd: 100_000,
    totalQuantity: 1,
  };
  const benign = {
    items: [{ variantExternalId: "var-a", quantity: 1, unitPriceVnd: 400_000, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 100_000,
    shippingFeeVnd: 0,
    totalVnd: 100_000,
    totalQuantity: 1,
  };

  assert.notEqual(
    issue({ quote: injected }),
    issue({ quote: benign }),
    "a delimiter-bearing id must not collide with a different canonical quote",
  );
});

test("P9a issuing refuses facts that are not usable website money", () => {
  const invalid = [
    { ...quote, items: [{ variantExternalId: "var-a", quantity: 0, unitPriceVnd: 1, fulfillmentState: "READY" as const }] },
    { ...quote, items: [{ variantExternalId: "", quantity: 1, unitPriceVnd: 1, fulfillmentState: "READY" as const }] },
    { ...quote, items: [{ variantExternalId: "var-a", quantity: 1.5, unitPriceVnd: 1, fulfillmentState: "READY" as const }] },
    { ...quote, totalVnd: Number.NaN },
    { ...quote, merchandiseSubtotalVnd: -1 },
    {
      ...quote,
      items: [
        { variantExternalId: "dupe", quantity: 1, unitPriceVnd: 1, fulfillmentState: "READY" as const },
        { variantExternalId: "dupe", quantity: 1, unitPriceVnd: 1, fulfillmentState: "READY" as const },
      ],
    },
  ];

  for (const badQuote of invalid) {
    assert.throws(
      () => issue({ quote: badQuote as RenderedQuoteProofFacts }),
      TypeError,
      `expected issuing to refuse ${JSON.stringify(badQuote.items)}`,
    );
  }
});

test("P9a issuing refuses an unusable cart identity or secret", () => {
  assert.throws(() => issue({ cartId: "" }), TypeError);
  assert.throws(() => issue({ secret: "too-short" }), TypeError);
});

test("P9a a free line is provable, because the order snapshot treats zero as supported money", () => {
  // The proof attests what a quote said; whether an amount is sellable belongs to the pricing
  // authority. Tightening past `isSupportedVndAmount` would make a quote the snapshot persists
  // unprovable, and this module throws where the snapshot does not.
  const free: RenderedQuoteProofFacts = {
    items: [{ variantExternalId: "gift", quantity: 1, unitPriceVnd: 0, fulfillmentState: "READY" as const }],
    merchandiseSubtotalVnd: 0,
    shippingFeeVnd: 0,
    totalVnd: 0,
    totalQuantity: 1,
  };
  const proof = issueRenderedQuoteProof({ quote: free, cartId, secret });
  assert.deepEqual(
    verifyRenderedQuoteProof({ proof, cartId, currentQuote: free, secret }),
    { ok: true },
  );
});

test("P9a verification is total, because it runs inside the snapshot transaction", () => {
  const proof = issue();
  // An exception here would abort a database transaction and reach the buyer as a generic outage
  // for what is really an ordinary re-confirm. Every one of these must fail closed instead.
  const unusable: RenderedQuoteProofFacts[] = [
    { ...quote, items: [] },
    { ...quote, totalQuantity: 0 },
    { ...quote, totalVnd: Number.NaN },
    { ...quote, merchandiseSubtotalVnd: -1 },
    { ...quote, items: [{ variantExternalId: "", quantity: 1, unitPriceVnd: 1, fulfillmentState: "READY" as const }] },
    { ...quote, items: [{ variantExternalId: "v", quantity: 0, unitPriceVnd: 1, fulfillmentState: "READY" as const }] },
  ];
  for (const currentQuote of unusable) {
    assert.deepEqual(
      verifyRenderedQuoteProof({ proof, cartId, currentQuote, secret }),
      { ok: false, reason: "PRICE_CHANGED" },
      `unusable current facts must fail closed, not throw: ${JSON.stringify(currentQuote.items)}`,
    );
  }

  assert.deepEqual(verifyRenderedQuoteProof({ proof, cartId: "", currentQuote: quote, secret }), {
    ok: false,
    reason: "PROOF_UNVERIFIED",
  });

  // A misconfigured server secret stays loud: failing closed on it would turn every checkout into
  // an unexplained permanent price-change loop with nothing pointing at the cause.
  assert.throws(
    () => verifyRenderedQuoteProof({ proof, cartId, currentQuote: quote, secret: "short" }),
    TypeError,
  );
});
