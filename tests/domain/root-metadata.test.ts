/**
 * U30a / W8 — the branded social card every route inherits when it declares none of its own.
 *
 * Routes that build their own Open Graph and Twitter metadata — a PDP, above all — must keep
 * overriding this. What is being proved here is only the fallback: a homepage, collection index or
 * lookbook share must still resolve to a real branded card on a trusted origin, rather than to
 * whatever the crawler decides to scrape.
 *
 * This is social-sharing presentation. It carries no relationship to the Meta Pixel or CAPI
 * contracts, which are separate and untouched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildRootMetadata } from "../../src/seo/root-metadata.ts";
import { SOCIAL_FALLBACK_ALT, SOCIAL_FALLBACK_PATH, SITE_NAME } from "../../src/seo/social-identity.ts";

const ORIGIN = "https://shop.example.com";

/** Next types `twitter` as a union of card shapes; `card` is only on the discriminated members. */
function twitterCard(metadata: ReturnType<typeof buildRootMetadata>): string | undefined {
  const twitter = metadata.twitter;
  return twitter !== null && twitter !== undefined && "card" in twitter ? twitter.card : undefined;
}

test("U30a gives every route a branded Open Graph fallback", () => {
  const metadata = buildRootMetadata({ origin: ORIGIN, indexingEnabled: true });

  assert.equal(metadata.openGraph?.siteName, SITE_NAME);
  assert.equal(metadata.openGraph?.title, "La.na Design - charismatic in every yard of cloth.");
  assert.equal(metadata.openGraph?.description, "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ");
  assert.deepEqual(metadata.openGraph?.images, [
    { url: `${ORIGIN}${SOCIAL_FALLBACK_PATH}`, alt: SOCIAL_FALLBACK_ALT },
  ]);
});

test("U30a gives every route a branded Twitter fallback", () => {
  const metadata = buildRootMetadata({ origin: ORIGIN, indexingEnabled: true });

  assert.equal(twitterCard(metadata), "summary_large_image");
  assert.equal(metadata.twitter?.title, "La.na Design - charismatic in every yard of cloth.");
  assert.equal(metadata.twitter?.description, "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ");
  assert.deepEqual(metadata.twitter?.images, [
    { url: `${ORIGIN}${SOCIAL_FALLBACK_PATH}`, alt: SOCIAL_FALLBACK_ALT },
  ]);
});

test("U30a resolves the fallback card from the trusted server-owned origin, never a relative path", () => {
  // A relative social image is resolved by whatever crawler reads it. The card has to name the
  // origin the server owns, and it has to follow that origin when it changes.
  const staging = buildRootMetadata({ origin: "https://staging.example.com", indexingEnabled: false });

  assert.deepEqual(staging.openGraph?.images, [
    { url: `https://staging.example.com${SOCIAL_FALLBACK_PATH}`, alt: SOCIAL_FALLBACK_ALT },
  ]);
  assert.deepEqual(staging.twitter?.images, [
    { url: `https://staging.example.com${SOCIAL_FALLBACK_PATH}`, alt: SOCIAL_FALLBACK_ALT },
  ]);
});

test("U30a leaves the existing root title, description and metadataBase exactly as they were", () => {
  const metadata = buildRootMetadata({ origin: ORIGIN, indexingEnabled: true });

  assert.deepEqual(metadata.title, {
    default: "La.na Design - charismatic in every yard of cloth.",
    template: "%s — La.na Design",
  });
  assert.equal(metadata.description, "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ");
  assert.equal(String(metadata.metadataBase), `${ORIGIN}/`);
});

test("U30a changes no indexing policy: robots still follows the search exposure gate", () => {
  // W8 is social presentation. It is not an approval to index anything, and ADR 0004 keeps the
  // temporary production domain non-indexable regardless of what the social card says.
  assert.equal(buildRootMetadata({ origin: ORIGIN, indexingEnabled: true }).robots, undefined);
  assert.deepEqual(buildRootMetadata({ origin: ORIGIN, indexingEnabled: false }).robots, {
    index: false,
    follow: false,
  });
});

test("U30a adds no canonical of its own to the root metadata", () => {
  // Self-canonical for static pages is U30b/W10 and answers to the indexing gate there. The social
  // fallback must not smuggle an indexable signal in ahead of it.
  assert.equal(buildRootMetadata({ origin: ORIGIN, indexingEnabled: true }).alternates, undefined);
  assert.equal(buildRootMetadata({ origin: ORIGIN, indexingEnabled: false }).alternates, undefined);
});

test("U30a invents no social account, handle or business fact", () => {
  const metadata = buildRootMetadata({ origin: ORIGIN, indexingEnabled: true });

  // `site` and `creator` name a Twitter account nobody has approved; leaving them absent is the
  // honest state, not an oversight to fill in later from a guess.
  assert.equal("site" in (metadata.twitter ?? {}), false);
  assert.equal("creator" in (metadata.twitter ?? {}), false);
  assert.equal("phoneNumbers" in (metadata.openGraph ?? {}), false);
  assert.equal("emails" in (metadata.openGraph ?? {}), false);
});

test("U30a / U41 includes owner-approved Google site verification token", () => {
  const metadata = buildRootMetadata({ origin: ORIGIN, indexingEnabled: true });

  assert.equal(metadata.verification?.google, "N2OZE83tu6EA4bc-oP1u2uhDYBrDwLKJJCZstMm5lhs");
});
