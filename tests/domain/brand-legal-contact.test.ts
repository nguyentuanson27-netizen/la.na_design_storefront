import assert from "node:assert/strict";
import test from "node:test";

import { BRAND, loadBrandConfig, type BrandConfig } from "../../src/brand/index.ts";
import {
  describePublicAddress,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../../src/content/public-brand-facts.ts";

/**
 * A2 — the registered legal identity and the customer-facing business contact are two different
 * facts about two different places, and the owner approved both.
 *
 * Brand Config held one address and one email, so publishing the registered address meant either
 * overwriting the business address or restating it as page prose. Both are how a returns label ends
 * up carrying a registered office the shop does not receive post at. What these tests pin is the
 * separation itself: two typed homes that cannot be written through each other, with the business
 * contact left exactly as its existing consumers already read it.
 */

function withBrand(mutate: (draft: BrandConfig) => BrandConfig) {
  return () => loadBrandConfig(mutate(structuredClone(BRAND) as BrandConfig));
}

test("A2 the registered legal facts are the approved ones, transcribed exactly", () => {
  assert.deepEqual(BRAND.legal, {
    registeredAddress:
      "Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công",
    email: "congtytnhh.las@gmail.com",
    // Transcribed as the source states it, in Vietnamese day/month/year order. No ISO form is
    // derived, because reading "7/10/2025" as a month-first date would silently move the date.
    taxIdIssueDate: "7/10/2025",
  });
});

test("A2 the legal address and email cannot be written through the business contact", () => {
  // Distinct concepts, so distinct values: the registered office is not where returns are received.
  assert.notEqual(BRAND.legal.registeredAddress, BRAND.contact.streetAddress);
  assert.notEqual(BRAND.legal.email, BRAND.contact.email);

  // Structural independence, not a coincidence of today's values: changing one leaves the other.
  const loaded = loadBrandConfig({
    ...(structuredClone(BRAND) as BrandConfig),
    legal: { ...BRAND.legal, email: "phaply@example.com" },
  }).brand;
  assert.equal(loaded.legal.email, "phaply@example.com");
  assert.equal(loaded.contact.email, BRAND.contact.email);
});

test("A2 every registered legal fact must be present, and fails closed when it is not", () => {
  for (const field of ["registeredAddress", "email", "taxIdIssueDate"] as const) {
    for (const blank of ["", "   "]) {
      assert.throws(
        withBrand((draft) => ({ ...draft, legal: { ...draft.legal, [field]: blank } })),
        new RegExp(`legal.${field}`),
        `blank ${field} must fail closed`,
      );
    }
  }
});

test("A2 the legal email is validated as an email, like the support address is", () => {
  for (const email of ["congtytnhh.las", "congtytnhh.las@", "@gmail.com", "a b@gmail.com"]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, legal: { ...draft.legal, email } })),
      /legal.email/,
      `${email} must fail closed`,
    );
  }
});

test("A2 the tax issue date must keep the approved day/month/year shape", () => {
  for (const date of ["2025-10-07", "7 tháng 10, 2025", "7/10/25", "07/2025"]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, legal: { ...draft.legal, taxIdIssueDate: date } })),
      /legal.taxIdIssueDate/,
      `${date} must fail closed`,
    );
  }
});

test("A2 no public legal-representative field exists to be rendered", () => {
  // The owner withheld the representative. Absence is the approved state, so there is no field to
  // leave blank and nothing for a later About page to reach for.
  for (const source of [BRAND.legal as Record<string, unknown>, PUBLIC_LEGAL_FACTS as Record<string, unknown>]) {
    for (const withheld of [
      "legalRepresentative",
      "representative",
      "representativeName",
      "nguoiDaiDien",
      "director",
    ]) {
      assert.equal(withheld in source, false, withheld);
    }
  }
});

test("A2 the public legal facts publish the whole registered identity from one place", () => {
  assert.deepEqual(PUBLIC_LEGAL_FACTS, {
    legalEntityName: BRAND.identity.legalName,
    taxCode: BRAND.identity.taxId,
    taxIdIssueDate: BRAND.legal.taxIdIssueDate,
    registeredAddress: BRAND.legal.registeredAddress,
    legalEmail: BRAND.legal.email,
  });
  assert.equal(Object.isFrozen(PUBLIC_LEGAL_FACTS), true);
});

test("A2 existing business-contact consumers are unchanged", () => {
  // The compatibility half. `PUBLIC_CONTACT_FACTS` is still exactly `BRAND.contact`, and the one
  // address helper still describes the business/return address rather than the registered one.
  assert.equal(PUBLIC_CONTACT_FACTS, BRAND.contact);
  assert.equal(
    describePublicAddress(),
    `${BRAND.contact.streetAddress}, ${BRAND.contact.addressLocality}`,
  );
  assert.equal(describePublicAddress().includes(BRAND.legal.registeredAddress), false);
});
