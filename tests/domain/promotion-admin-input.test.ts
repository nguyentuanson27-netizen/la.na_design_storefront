import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCampaignFormInput,
  parseStrictVietnamDateTime,
  parseTargets,
} from "../../src/commerce/promotion-admin-input.ts";
import {
  MAX_PROMOTION_IDENTIFIER_LENGTH,
  MAX_TARGETS_PER_CAMPAIGN,
  validateDraftInput,
} from "../../src/commerce/promotion-activation.ts";

test("Finding 1: parseTargets preserves oversized target IDs without truncation so domain validator rejects IDENTIFIER_TOO_LONG", () => {
  const oversizedId = "p_".concat("x".repeat(MAX_PROMOTION_IDENTIFIER_LENGTH + 10));
  assert.ok(oversizedId.length > MAX_PROMOTION_IDENTIFIER_LENGTH);

  const formData = new FormData();
  formData.append("targetProductId", `  ${oversizedId}  `);
  formData.append("targetVariantId", "  v-valid  ");

  const targets = parseTargets(formData);
  assert.equal(targets.length, 2);

  // Critical: the ID must NOT have been sliced down to 128 characters!
  assert.equal(targets[0]?.productId, oversizedId, "oversized ID is preserved verbatim (after trim)");
  assert.equal(targets[1]?.variantId, "v-valid");

  // When passed to validateDraftInput, the domain validator catches it!
  const validated = validateDraftInput({ targets });
  assert.equal(validated.ok, false);
  assert.ok(!validated.ok && validated.errors.includes("IDENTIFIER_TOO_LONG"));
});

test("Finding 1: parseTargets bounds target count extraction to prevent memory denial-of-service", () => {
  const formData = new FormData();
  for (let i = 0; i < MAX_TARGETS_PER_CAMPAIGN + 20; i++) {
    formData.append("targetProductId", `prod-${i}`);
  }

  const targets = parseTargets(formData);
  assert.equal(targets.length, MAX_TARGETS_PER_CAMPAIGN + 1);

  const validated = validateDraftInput({ targets });
  assert.equal(validated.ok, false);
  assert.ok(!validated.ok && validated.errors.includes("TOO_MANY_TARGETS"));
});

test("Required 3: parseStrictVietnamDateTime strictly validates calendar correctness and rejects invalid representations", () => {
  // Valid representations in local Vietnam time (UTC+07:00)
  const valid1 = parseStrictVietnamDateTime("2026-09-20T10:00");
  assert.equal(valid1.ok, true);
  if (valid1.ok) {
    assert.equal(valid1.date?.toISOString(), "2026-09-20T03:00:00.000Z");
  }

  const valid2 = parseStrictVietnamDateTime("2026-09-20T10:00:45");
  assert.equal(valid2.ok, true);
  if (valid2.ok) {
    assert.equal(valid2.date?.toISOString(), "2026-09-20T03:00:45.000Z");
  }

  // Optional empty/null values map to null
  assert.deepEqual(parseStrictVietnamDateTime(""), { ok: true, date: null });
  assert.deepEqual(parseStrictVietnamDateTime("   "), { ok: true, date: null });
  assert.deepEqual(parseStrictVietnamDateTime(null), { ok: true, date: null });
  assert.deepEqual(parseStrictVietnamDateTime(undefined), { ok: true, date: null });

  // Malformed representations must be rejected (not coerced to null or normalized by JS Date)
  const invalidDates = [
    "2026/09/20 10:00", // slash format
    "Sep 20 2026", // words
    "2026-09-20Z", // missing time
    "foo", // garbage
    "2026-02-31T10:00", // Feb 31 does not exist
    "2026-04-31T10:00", // April has 30 days
    "2026-13-99T99:99", // impossible month/day/time
    "2026-09-20T25:00", // hour 25
    "2026-09-20T10:60", // minute 60
  ];

  for (const bad of invalidDates) {
    const res = parseStrictVietnamDateTime(bad);
    assert.equal(res.ok, false, `expected "${bad}" to be rejected`);
  }
});

test("Required 3: parseCampaignFormInput rejects invalid kind without fail-open coercion", () => {
  for (const bad of ["HACKED", "PROMO", "promotion", "FLASH", "clearance", " CLEARANCE_X", ""]) {
    const formData = new FormData();
    formData.append("kind", bad);
    formData.append("discountType", "PERCENTAGE");

    const res = parseCampaignFormInput(formData);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "INVALID_CAMPAIGN_KIND", `expected "${bad}" to reject with INVALID_CAMPAIGN_KIND`);
    }
  }
});

test("Required 3: parseCampaignFormInput rejects invalid discountType without fail-open coercion", () => {
  for (const bad of ["BOGUS", "FIXED", "percentage", "CASH", ""]) {
    const formData = new FormData();
    formData.append("kind", "PROMOTION");
    formData.append("discountType", bad);

    const res = parseCampaignFormInput(formData);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "INVALID_DISCOUNT_TYPE", `expected "${bad}" to reject with INVALID_DISCOUNT_TYPE`);
    }
  }
});

test("Required 3: parseCampaignFormInput strictly rejects malformed fixed price and invalid percentage", () => {
  for (const badPrice of ["-100", "+100", "1e6", "1.5", "199,000", "abc500000", "0"]) {
    const formData = new FormData();
    formData.append("kind", "PROMOTION");
    formData.append("discountType", "FIXED_PRICE");
    formData.append("fixedPriceVnd", badPrice);

    const res = parseCampaignFormInput(formData);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "MALFORMED_FIXED_PRICE", `expected "${badPrice}" to fail with MALFORMED_FIXED_PRICE`);
    }
  }

  for (const badPct of ["-10", "0", "100", "105", "1e2", "abc"]) {
    const formData = new FormData();
    formData.append("kind", "PROMOTION");
    formData.append("discountType", "PERCENTAGE");
    formData.append("percentageValue", badPct);

    const res = parseCampaignFormInput(formData);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "INVALID_PERCENTAGE", `expected "${badPct}" to fail with INVALID_PERCENTAGE`);
    }
  }
});

test("Required 3: parseCampaignFormInput strictly parses valid full campaign form", () => {
  const formData = new FormData();
  formData.append("name", "Chiến dịch Thu Đông 2026");
  formData.append("kind", "FLASH_SALE");
  formData.append("discountType", "FIXED_PRICE");
  formData.append("fixedPriceVnd", "  450000  ");
  formData.append("startsAt", "2026-10-01T09:00");
  formData.append("endsAt", "2026-10-05T21:00");
  formData.append("targetProductId", "prod-1");
  formData.append("targetVariantId", "var-2");

  const res = parseCampaignFormInput(formData);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.name, "Chiến dịch Thu Đông 2026");
    assert.equal(res.value.kind, "FLASH_SALE");
    assert.equal(res.value.discountType, "FIXED_PRICE");
    assert.equal(res.value.fixedPriceVnd, BigInt(450000));
    assert.equal(res.value.percentageValue, null);
    assert.equal(res.value.startsAt?.toISOString(), "2026-10-01T02:00:00.000Z");
    assert.equal(res.value.endsAt?.toISOString(), "2026-10-05T14:00:00.000Z");
    assert.equal(res.value.targets.length, 2);
  }
});

test("the Xả hàng lẻ size kind parses like a Promotion, with no window required", () => {
  const formData = new FormData();
  formData.append("name", "Xả hàng lẻ size");
  formData.append("kind", " CLEARANCE ");
  formData.append("discountType", "PERCENTAGE");
  formData.append("percentageValue", "40");
  formData.append("targetProductId", "prod-1");

  const res = parseCampaignFormInput(formData);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.kind, "CLEARANCE");
    assert.equal(res.value.startsAt, null);
    assert.equal(res.value.endsAt, null);
  }
});
