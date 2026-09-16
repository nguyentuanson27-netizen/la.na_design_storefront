import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DYNAMIC_SITEMAP_PATHS,
  STATIC_CANONICAL_PATHS,
} from "../../src/seo/search-sitemap-repository.ts";
import { summarizeSitemapCapacity } from "../../src/seo/sitemap-capacity.ts";

test("the single-sitemap budget is the dynamic bound plus every static canonical path", () => {
  const report = summarizeSitemapCapacity({
    productPaths: MAX_DYNAMIC_SITEMAP_PATHS - 1,
    collectionPaths: 1,
  });

  assert.equal(report.dynamicPaths, MAX_DYNAMIC_SITEMAP_PATHS);
  assert.equal(report.staticPaths, STATIC_CANONICAL_PATHS.length);
  assert.equal(
    report.totalPaths,
    50_000,
    "49,996 dynamic + 4 static is the whole single-sitemap budget",
  );
  assert.equal(report.exceedsDynamicBudget, false, "the bound itself is still accepted");
  assert.equal(report.remainingDynamicHeadroom, 0);
  assert.equal(report.utilizationPercent, 100);
});

test("one path past the dynamic bound is over budget", () => {
  const report = summarizeSitemapCapacity({
    productPaths: MAX_DYNAMIC_SITEMAP_PATHS,
    collectionPaths: 1,
  });

  assert.equal(report.dynamicPaths, MAX_DYNAMIC_SITEMAP_PATHS + 1);
  assert.equal(
    report.exceedsDynamicBudget,
    true,
    "49,997 dynamic paths is what makes the repository refuse to build the sitemap",
  );
  assert.equal(report.remainingDynamicHeadroom, 0, "headroom floors at zero rather than going negative");
});

test("the static path count is read from the canonical list, not restated", () => {
  // If a static canonical path is ever added, the budget arithmetic has to move with it rather
  // than keep reporting a stale constant.
  // U33a added `/about` and `/contact`; U33b added `/returns` and `/shipping`; U33c added
  // `/size-guide`; A7b added `/policies`. The pin is deliberate rather than derived: it exists so a
  // new static path cannot silently widen the document, which means updating it is the moment to
  // notice the dynamic budget shrank by the same amount.
  assert.equal(STATIC_CANONICAL_PATHS.length, 10);
  assert.equal(summarizeSitemapCapacity({ productPaths: 0, collectionPaths: 0 }).staticPaths, 10);
});

test("the dynamic bound is the per-document limit less the static paths", () => {
  // The bound is derived, so this pins the reviewed value the derivation currently produces: an
  // eleventh static path must cost a dynamic slot rather than quietly widen the document past
  // 50,000. A7b's `/policies` cost one, taking the bound from 49,991 to 49,990.
  assert.equal(MAX_DYNAMIC_SITEMAP_PATHS, 49_990);
  assert.equal(MAX_DYNAMIC_SITEMAP_PATHS + STATIC_CANONICAL_PATHS.length, 50_000);
});

test("an empty catalog reports the whole dynamic budget as headroom", () => {
  const report = summarizeSitemapCapacity({ productPaths: 0, collectionPaths: 0 });

  assert.deepEqual(report, {
    productPaths: 0,
    collectionPaths: 0,
    dynamicPaths: 0,
    staticPaths: 10,
    totalPaths: 10,
    dynamicBudget: MAX_DYNAMIC_SITEMAP_PATHS,
    remainingDynamicHeadroom: MAX_DYNAMIC_SITEMAP_PATHS,
    utilizationPercent: 0,
    exceedsDynamicBudget: false,
  });
});

test("utilization is the dynamic share of the dynamic budget", () => {
  const report = summarizeSitemapCapacity({ productPaths: 42, collectionPaths: 4 });

  assert.equal(report.dynamicPaths, 46);
  assert.equal(report.remainingDynamicHeadroom, MAX_DYNAMIC_SITEMAP_PATHS - 46);
  assert.equal(report.utilizationPercent, 0.092);
});

test("counts that are not safe non-negative integers are refused rather than reported", () => {
  for (const counts of [
    { productPaths: -1, collectionPaths: 0 },
    { productPaths: 0, collectionPaths: -1 },
    { productPaths: 1.5, collectionPaths: 0 },
    { productPaths: Number.NaN, collectionPaths: 0 },
    { productPaths: Number.POSITIVE_INFINITY, collectionPaths: 0 },
    { productPaths: 0, collectionPaths: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    assert.throws(
      () => summarizeSitemapCapacity(counts),
      RangeError,
      `expected ${JSON.stringify(counts)} to be refused`,
    );
  }
});
