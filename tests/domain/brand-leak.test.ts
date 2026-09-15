import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BRAND, FULFILLMENT, NAVIGATION, SIZE_GUIDE } from "../../src/brand/index.ts";
import { MERCHANT_BRAND } from "../../src/commerce/merchant-offer-mapper.ts";
import { MERCHANT_SHOP_APPAREL_DEFAULTS } from "../../src/commerce/merchant-apparel-facts.ts";
import { SOCIAL_FALLBACK_ALT, SOCIAL_FALLBACK_PATH, SITE_NAME } from "../../src/seo/social-identity.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Scanned: all application source. A narrower scope is what let a hardcoded brand name survive in
 * `src/content`, `src/seo` and `src/commerce` while this gate reported clean — the leak does not
 * care which directory it is in, so neither does the scan.
 */
const SCANNED_ROOTS = ["src"] as const;

/**
 * Ignored, each for a stated reason rather than convenience:
 * - `src/brand` is the source these needles come from.
 * - the admin surface is explicitly out of the brand contract: it does not change per brand.
 * - `src/generated` is Prisma output, not authored code.
 * - the Merchant apparel vocabulary defines Google's controlled values ("male", "adult"). Those are
 *   the vocabulary a brand *picks from*, not brand strings, and the module that declares the list is
 *   their source in the same way `src/brand` is the source of brand truth.
 */
const IGNORED = [
  "src/brand",
  "src/app/admin",
  "src/components/admin",
  "src/generated",
  "src/commerce/merchant-apparel-facts.ts",
] as const;

/** Short enough to appear legitimately in unrelated words; declared needles cover the rest. */
const MINIMUM_NEEDLE_LENGTH = 4;

/**
 * Every string leaf of the config, recursively. A new brand fact is protected the moment it is
 * added — a hand-written list of fields would rot, which is exactly how a narrower version of this
 * gate let a hardcoded phone number through.
 */
function collectBrandStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    if (node.trim().length >= MINIMUM_NEEDLE_LENGTH) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const value of node) collectBrandStrings(value, out);
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectBrandStrings(value, out);
    }
  }
  return out;
}

/** Unaccented spelling, for slugs and alt text that drop the diacritics. */
function deaccent(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Every string leaf of BRAND, SIZE_GUIDE and FULFILLMENT, plus the brand-bearing part of NAVIGATION.
 *
 * This is the ratified contract, not a deviation: spec section 5.1 and Task 9 in
 * `nguyentuanson27-netizen/webtemplate@main` (v1.6, merged as a85f863) define the needle set as
 * BRAND + SIZE_GUIDE + FULFILLMENT plus `NAVIGATION.brandHomeLabel` only.
 *
 * The measurement behind that decision, at this scan scope: NAVIGATION has 39 string leaves of four
 * or more characters and 23 of them fire on 65 files -- route paths ("/shop" in 54 files, "/search"
 * in 44) and generic Vietnamese UI nouns ("Cửa hàng" in 10). That is three kinds of string with
 * three different owners: `brandHomeLabel` is brand identity and belongs here; a `href` is route
 * identity and belongs to no gate at this layer by design -- changing brand does not change
 * "/cart" -- with the href-to-route check assigned to T11 (spec section 5.2); a `label` is UI
 * vocabulary, prevented from duplicating structurally by the test below (spec section 5.3).
 *
 * The exemption is permanent, not a deferral. The scan scope includes `src/components/brand/**`,
 * which is where Phase E puts presentation, so an `<h1>Cửa hàng</h1>` stays in scope afterwards
 * exactly as it is now. No later phase makes these legitimate duplications disappear.
 */
function brandNeedles(): readonly string[] {
  const needles = new Set<string>();
  for (const value of [
    ...collectBrandStrings(BRAND),
    ...collectBrandStrings(SIZE_GUIDE),
    ...collectBrandStrings(FULFILLMENT),
    ...collectBrandStrings(NAVIGATION.brandHomeLabel),
    ...BRAND.identity.additionalNeedles,
  ]) {
    needles.add(value);
    const bare = deaccent(value);
    if (bare !== value) needles.add(bare);
  }
  return [...needles];
}

/**
 * Comments and JSDoc are stripped before scanning: they never reach a reader of the page, and an
 * explanation of why a fact is single-sourced should be allowed to name the fact.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function* walkSource(relativeRoot: string): Generator<string> {
  const absolute = path.join(REPO_ROOT, relativeRoot);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relativeRoot, entry.name);
    if (IGNORED.some((ignored) => child === ignored || child.startsWith(`${ignored}/`))) continue;
    if (entry.isDirectory()) yield* walkSource(child);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield child;
  }
}

function findLeaks(needles: readonly string[]): readonly string[] {
  const leaked: string[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const relative of walkSource(root)) {
      const source = stripComments(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
      for (const [index, line] of source.split("\n").entries()) {
        for (const needle of needles) {
          if (line.includes(needle)) leaked.push(`${relative}:${index + 1}: ${needle}`);
        }
      }
    }
  }
  return leaked;
}

test("no brand string is written straight into storefront presentation", () => {
  const leaked = findLeaks(brandNeedles());
  assert.deepEqual(
    leaked,
    [],
    `Brand strings hardcoded outside src/brand:\n${leaked.join("\n")}`,
  );
});

test("the gate catches a hardcoded brand fact rather than passing vacuously", () => {
  // Exactly what a page would look like if someone pasted the phone number or the brand name in.
  const fixture = `export const Contact = () => <a href="tel:${BRAND.contact.telephone}">${BRAND.identity.name}</a>;`;
  const needles = brandNeedles();
  assert.ok(needles.some((needle) => fixture.includes(needle)));
  assert.ok(needles.includes(BRAND.contact.telephone));
  assert.ok(needles.includes(BRAND.identity.name));
  assert.ok(needles.includes(BRAND.contact.email));
  assert.ok(needles.includes(BRAND.identity.positioning));
  assert.ok(needles.includes(BRAND.identity.legalName));
  assert.ok(needles.includes(SIZE_GUIDE.charts[0]!.title));
  assert.ok(needles.includes(NAVIGATION.brandHomeLabel));
  // Fulfillment policy is brand truth too: a page must not restate a returns or delivery clause.
  assert.ok(needles.includes(FULFILLMENT.returns.refundChannelNote));
  assert.ok(needles.includes(FULFILLMENT.delivery.estimateCaveat));
  assert.ok(needles.includes(FULFILLMENT.deliveryScopeLabels.innerCity));
  assert.ok(needles.includes(FULFILLMENT.returnLogistics.nonDefectiveRefundNote));
});

test("a new brand fact is protected without editing this test", () => {
  const extended = { ...BRAND, identity: { ...BRAND.identity, motto: "Một câu khẩu hiệu mới" } };
  assert.ok(collectBrandStrings(extended).includes("Một câu khẩu hiệu mới"));
});

/* The three values that do not live under src/app, so the scan above cannot see them. */

/** The files whose whole job is to render NAVIGATION. */
const NAVIGATION_CONSUMERS = [
  "src/components/brand/site-header.tsx",
  "src/components/brand/site-footer.tsx",
] as const;

/** Every configured destination and label, the wordmark label included. */
function navigationStrings(): readonly string[] {
  const entries = [
    ...NAVIGATION.primary,
    ...NAVIGATION.mobileUtility,
    ...NAVIGATION.utility,
    ...NAVIGATION.footer,
  ];
  return [...entries.map((e) => e.href), ...entries.map((e) => e.label), NAVIGATION.brandHomeLabel];
}

/**
 * The text a link element renders, for every link in the source.
 *
 * Scoping to link elements is the whole point. A first version of this check rejected any
 * configured label appearing anywhere in these files, and it immediately failed on the footer's
 * `<dt>Vận chuyển</dt>` -- an info-block heading that collides with the `/shipping` menu label by
 * coincidence. That is a legitimate duplicate, not a hardcoded menu. The duplication that matters
 * is a *link* that carries its own label instead of the configured one.
 */
function linkTexts(source: string): readonly string[] {
  return [...source.matchAll(/<(?:Link|a)\b[^>]*>([\s\S]*?)<\/(?:Link|a)>/g)].map((m) => m[1]!);
}

/**
 * The structural constraint that stands in for scanning NAVIGATION recursively.
 *
 * Destinations and labels are both checked, and the label half is the half that matters: labels are
 * permanently exempt from the repo-wide gate above, so this is the only thing standing between a
 * configured menu and a duplicated one. Checking destinations alone would let
 * `NAVIGATION.primary.map(item => <Link href={item.href}>Cửa hàng</Link>)` pass while hardcoding
 * the label it just read.
 *
 * Scope is these two files, not all of `src` -- which is why it does not contradict the exemption.
 */
test("the header and footer take both destinations and labels from NAVIGATION", () => {
  for (const component of NAVIGATION_CONSUMERS) {
    const source = stripComments(readFileSync(path.join(REPO_ROOT, component), "utf8"));
    assert.match(source, /NAVIGATION\./, `${component} must read NAVIGATION`);

    // A hardcoded menu shows up as a literal destination in the markup. The home link is not a
    // menu entry -- it is the wordmark, which every brand has and no brand configures away.
    assert.doesNotMatch(
      source,
      /href="\/[^"]+"/,
      `${component} must not hardcode a navigation target`,
    );

    for (const text of linkTexts(source)) {
      for (const configured of navigationStrings()) {
        assert.ok(
          !text.includes(configured),
          `${component} renders a link whose text hardcodes the configured ${configured}`,
        );
      }
    }
  }
});

test("the navigation structural gate catches a hardcoded label, not just a hardcoded href", () => {
  const label = NAVIGATION.primary[0]!.label;
  const hardcodedLabel = `NAVIGATION.primary.map((item) => <Link href={item.href}>${label}</Link>)`;
  const fromConfig = `NAVIGATION.primary.map((item) => <Link href={item.href}>{item.label}</Link>)`;

  // The destination is read from NAVIGATION in both, so the href check cannot tell them apart --
  // this is exactly the shape that passed before link text was covered.
  assert.doesNotMatch(hardcodedLabel, /href="\/[^"]+"/);

  assert.ok(linkTexts(hardcodedLabel).some((t) => t.includes(label)), "must reject the hardcoded label");
  assert.ok(linkTexts(fromConfig).every((t) => !t.includes(label)), "must accept the configured label");
});

test("the Merchant feed brand is the configured feed brand", () => {
  assert.equal(MERCHANT_BRAND, BRAND.merchant.feedBrand);
  assert.equal(MERCHANT_SHOP_APPAREL_DEFAULTS.gender, BRAND.merchant.defaultGender);
  assert.equal(MERCHANT_SHOP_APPAREL_DEFAULTS.ageGroup, BRAND.merchant.defaultAgeGroup);
});

test("the Better Auth app name is the configured brand name", async () => {
  // Imported inside the test: src/auth/server.ts builds the real Better Auth instance at module
  // load and needs a server environment, which a domain test must not require of the whole file.
  const saved = {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  process.env.BETTER_AUTH_SECRET ??= "domain-test-placeholder-secret-0123456789abcdef";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:5432/placeholder";

  try {
    const { auth } = await import("../../src/auth/server.ts");
    assert.equal(auth.options.appName, BRAND.identity.name);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the social card route directory matches the configured slug", () => {
  const directories = readdirSync(path.join(REPO_ROOT, "src", "app"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-social-card.png"))
    .map((entry) => entry.name);

  assert.deepEqual(
    directories,
    [`${BRAND.identity.socialCardSlug}.png`],
    "the social card route folder must match BRAND.identity.socialCardSlug, or the OG image 404s",
  );
  assert.equal(SOCIAL_FALLBACK_PATH, `/${BRAND.identity.socialCardSlug}.png`);
  assert.equal(SOCIAL_FALLBACK_ALT, BRAND.identity.socialCardAlt);
  assert.equal(SITE_NAME, BRAND.identity.name);
});
