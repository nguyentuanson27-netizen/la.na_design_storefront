import assert from "node:assert/strict";
import test from "node:test";

import { submitGuestCheckoutPublicAction } from "../../src/commerce/guest-checkout-public-actions.ts";

function makeFormData() {
  const formData = new FormData();
  formData.set("name", "Nguyễn Văn A");
  formData.set("phone", "0901234567");
  formData.set("provinceRef", "84_VN101");
  // A stale page could still post a district; the two-level address never forwards it.
  formData.set("districtRef", "district-001");
  formData.set("communeRef", "84_VN10105");
  formData.set("detail", "12 Đường A");
  formData.set("note", "Giao giờ hành chính");
  formData.set("cartId", "attacker-cart");
  formData.set("shopId", "999999");
  formData.set("publicCode", "ATTACKER-CODE");
  formData.set("price", "1");
  return formData;
}

const allowAttempt = async () => true;

test("browser checkout uses the HttpOnly cart identity and forwards only allowlisted guest fields", async () => {
  let submittedInput: unknown;
  const cartSession = {
    read: () => "server-cart-id",
    clear: () => undefined,
  };

  const result = await submitGuestCheckoutPublicAction(
    {
      cartSession,
      consumeAttempt: allowAttempt,
      submitCheckout: async (input) => {
        submittedInput = input;
        return { ok: true as const, status: "CONFIRMED" as const, orderCode: "LA-001" };
      },
    },
    makeFormData(),
  );

  assert.deepEqual(submittedInput, {
    cartId: "server-cart-id",
    checkoutInput: {
      name: "Nguyễn Văn A",
      phone: "0901234567",
      provinceRef: "84_VN101",
      communeRef: "84_VN10105",
      detail: "12 Đường A",
      note: "Giao giờ hành chính",
    },
    // Absent from this form, and forwarded as the absence rather than silently defaulted: an
    // unproven submission has to reach the verifier and fail there, not be waved through here.
    quoteProof: null,
  });
  assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: "LA-001" });
});

test("the rendered-quote proof is forwarded verbatim and is the only browser field that may be opaque", async () => {
  let submittedInput: { quoteProof?: unknown; checkoutInput?: unknown } | undefined;
  const formData = makeFormData();
  formData.set("quoteProof", "cGF5bG9hZA.bWFj");
  // A browser-supplied price alongside it must not survive the allowlist.
  formData.set("totalVnd", "1");
  formData.set("unitPriceVnd", "1");

  await submitGuestCheckoutPublicAction(
    {
      cartSession: { read: () => "server-cart-id", clear: () => undefined },
      consumeAttempt: allowAttempt,
      submitCheckout: async (input) => {
        submittedInput = input;
        return { ok: true as const, status: "CONFIRMED" as const, orderCode: "LA-003" };
      },
    },
    formData,
  );

  assert.equal(submittedInput?.quoteProof, "cGF5bG9hZA.bWFj");
  assert.equal(
    Object.hasOwn(submittedInput?.checkoutInput as object, "totalVnd"),
    false,
    "browser money fields must never reach the snapshot input",
  );
  assert.equal(Object.hasOwn(submittedInput?.checkoutInput as object, "unitPriceVnd"), false);
});

test("confirmed checkout clears the anonymous cart cookie but ambiguous checkout never does", async () => {
  for (const entry of [
    {
      outcome: { ok: true as const, status: "CONFIRMED" as const, orderCode: "LA-001" },
      expectedClears: 1,
    },
    {
      outcome: { ok: false as const, status: "SYNC_UNKNOWN" as const, orderCode: "LA-002" },
      expectedClears: 0,
    },
    {
      outcome: { ok: false as const, status: "PROCESSING" as const, orderCode: "LA-003" },
      expectedClears: 0,
    },
  ]) {
    let clearCalls = 0;
    const result = await submitGuestCheckoutPublicAction(
      {
        cartSession: {
          read: () => "server-cart-id",
          clear: () => {
            clearCalls += 1;
          },
        },
        consumeAttempt: allowAttempt,
        submitCheckout: async () => entry.outcome,
      },
      makeFormData(),
    );

    assert.deepEqual(result, entry.outcome);
    assert.equal(clearCalls, entry.expectedClears);
  }
});

test("missing anonymous cart stops before checkout submission and rate limiting", async () => {
  let limiterCalls = 0;
  let submitCalls = 0;
  const result = await submitGuestCheckoutPublicAction(
    {
      cartSession: { read: () => null, clear: () => undefined },
      consumeAttempt: async () => {
        limiterCalls += 1;
        return true;
      },
      submitCheckout: async () => {
        submitCalls += 1;
        throw new Error("must not submit");
      },
    },
    makeFormData(),
  );

  assert.deepEqual(result, {
    ok: false,
    status: "RETRYABLE",
    reason: "CART_UNAVAILABLE",
  });
  assert.equal(limiterCalls, 0);
  assert.equal(submitCalls, 0);
});

test("rate-limited anonymous cart stops before checkout submission", async () => {
  let limiterCalls = 0;
  let submitCalls = 0;
  const dependencies = {
    cartSession: { read: () => "server-cart-id", clear: () => undefined },
    consumeAttempt: async (cartId: string) => {
      limiterCalls += 1;
      assert.equal(cartId, "server-cart-id");
      return false;
    },
    submitCheckout: async () => {
      submitCalls += 1;
      return { ok: true as const, status: "CONFIRMED" as const, orderCode: "LA-should-not-run" };
    },
  };

  const result = await submitGuestCheckoutPublicAction(dependencies, makeFormData());

  assert.deepEqual(result, {
    ok: false,
    status: "RETRYABLE",
    reason: "CHECKOUT_UNAVAILABLE",
  });
  assert.equal(limiterCalls, 1);
  assert.equal(submitCalls, 0);
});

test("rate-limit storage failure fails closed before checkout submission", async () => {
  let submitCalls = 0;
  const result = await submitGuestCheckoutPublicAction(
    {
      cartSession: { read: () => "server-cart-id", clear: () => undefined },
      consumeAttempt: async () => {
        throw new Error("database details must not escape");
      },
      submitCheckout: async () => {
        submitCalls += 1;
        return { ok: true as const, status: "CONFIRMED" as const, orderCode: "LA-should-not-run" };
      },
    },
    makeFormData(),
  );

  assert.deepEqual(result, {
    ok: false,
    status: "RETRYABLE",
    reason: "CHECKOUT_UNAVAILABLE",
  });
  assert.equal(submitCalls, 0);
});
