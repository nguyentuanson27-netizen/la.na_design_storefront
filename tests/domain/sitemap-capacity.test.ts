import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DYNAMIC_SITEMAP_PATHS,
  STATIC_CANONICAL_PATHS,
} from "../../src/seo/search-sitemap-repository.ts";
import { summarizeSitemapCapacity } from "../../src/seo/sitemap-capacity.ts";

const EXPECTED_STATIC_PATHS = 23;
const EXPECTED_DYNAMIC_BUDGET = 50_000 - EXPECTED_STATIC_PATHS;

test("the single-sitemap budget is the dynamic bound plus every static canonical path", () => {
  const report = summarizeSitemapCapacity({
    productPaths: MAX_DYNAMIC_SITEMAP_PATHS - 1,
    collectionPaths: 1,
  });
  assert.equal(report.dynamicPaths, MAX_DYNAMIC_SITEMAP_PATHS);
  assert.equal(report.staticPaths, STATIC_CANONICAL_PATHS.length);
  assert.equal(report.totalPaths, 50_000);
  assert.equal(report.exceedsDynamicBudget, false);
  assert.equal(report.remainingDynamicHeadroom, 0);
  assert.equal(report.utilizationPercent, 100);
});

test("one path past the dynamic bound is over budget", () => {
  const report = summarizeSitemapCapacity({
    productPaths: MAX_DYNAMIC_SITEMAP_PATHS,
    collectionPaths: 1,
  });
  assert.equal(report.dynamicPaths, MAX_DYNAMIC_SITEMAP_PATHS + 1);
  assert.equal(report.exceedsDynamicBudget, true);
  assert.equal(report.remainingDynamicHeadroom, 0);
});

test("F3a/A8 static path expansion is explicit and keeps the sitemap bounded", () => {
  assert.equal(STATIC_CANONICAL_PATHS.length, EXPECTED_STATIC_PATHS);
  assert.equal(MAX_DYNAMIC_SITEMAP_PATHS, EXPECTED_DYNAMIC_BUDGET);
  assert.equal(MAX_DYNAMIC_SITEMAP_PATHS + STATIC_CANONICAL_PATHS.length, 50_000);
});

test("an empty catalog reports the whole dynamic budget as headroom", () => {
  const report = summarizeSitemapCapacity({ productPaths: 0, collectionPaths: 0 });
  assert.deepEqual(report, {
    productPaths: 0,
    collectionPaths: 0,
    dynamicPaths: 0,
    staticPaths: EXPECTED_STATIC_PATHS,
    totalPaths: EXPECTED_STATIC_PATHS,
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
    assert.throws(() => summarizeSitemapCapacity(counts), RangeError);
  }
});
