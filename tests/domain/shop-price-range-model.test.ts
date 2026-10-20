import assert from "node:assert/strict";
import test from "node:test";

import { validateShopPriceRange } from "../../src/components/headless/shop-price-range-model.ts";
import { parseStorefrontDiscoverySearchParams } from "../../src/commerce/storefront-discovery.ts";

const limitVnd = 1_000_000_000;

const issue = (min: string, max: string) => validateShopPriceRange({ min, max, limitVnd });

test("empty and ordinary ranges pass", () => {
  assert.equal(issue("", ""), null);
  assert.equal(issue("500000", ""), null);
  assert.equal(issue("", "900000"), null);
  assert.equal(issue("0", "0"), null);
  assert.equal(issue(" 300000 ", "900000"), null);
  assert.equal(issue("300000", "300000"), null);
});

test("a minimum above the maximum is reported on the maximum field", () => {
  const result = issue("900000", "300000");
  assert.equal(result?.field, "max");
  assert.match(result?.message ?? "", /lớn hơn hoặc bằng/);
});

test("anything the loader would 404 on is reported in the field instead", () => {
  for (const bad of ["1e5", "-1", "1.5", "1,000", "abc", "007", "0x10", "٣"]) {
    assert.equal(issue(bad, "")?.field, "min", `${bad} must be refused as a minimum`);
    assert.equal(issue("", bad)?.field, "max", `${bad} must be refused as a maximum`);
  }
  assert.equal(issue(String(limitVnd + 1), "")?.field, "min");
  assert.equal(issue("", "9".repeat(20))?.field, "max");
  // The limit itself is allowed.
  assert.equal(issue(String(limitVnd), ""), null);
});

test("every range the field accepts is one the loader accepts, and the reverse", () => {
  const cases: Array<[string, string]> = [
    ["", ""], ["0", "0"], ["1", "2"], ["500000", ""], ["", "500000"],
    ["900000", "300000"], ["1e5", ""], ["", "-3"], ["007", ""], [String(limitVnd), ""],
    [String(limitVnd + 1), ""],
  ];
  for (const [min, max] of cases) {
    let loaderAccepts = true;
    try {
      parseStorefrontDiscoverySearchParams({ minPrice: min, maxPrice: max });
    } catch {
      loaderAccepts = false;
    }
    assert.equal(
      issue(min, max) === null,
      loaderAccepts,
      `field and loader disagree about min=${JSON.stringify(min)} max=${JSON.stringify(max)}`,
    );
  }
});
