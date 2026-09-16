import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NAVIGATION } from "../../src/brand/index.ts";
import { matchesStorefrontRoute } from "../../src/routes/manifest.ts";

const EXPECTED_PRIMARY = ["Áo dài", "Set đồ", "Váy, đầm", "Phụ kiện", "Hàng mới về", "Bộ sưu tập", "Sale"];
const EXPECTED_AO_DAI = ["Áo dài cách tân", "Áo dài Tết", "Áo dài cưới", "Áo dài 4 tà", "Áo dài 6 tà"];
const EXPECTED_SET_DO = ["Set váy", "Set quần áo"];

function activePrimaryHrefs(): string[] {
  return NAVIGATION.primary.flatMap((item) => [item.href, ...(item.children?.map((child) => child.href) ?? [])]);
}

test("A6 primary navigation has the exact approved order and hierarchy", () => {
  assert.deepEqual(NAVIGATION.primary.map((item) => item.label), EXPECTED_PRIMARY);
  assert.deepEqual(NAVIGATION.primary[0]?.children?.map((child) => child.label), EXPECTED_AO_DAI);
  assert.deepEqual(NAVIGATION.primary[1]?.children?.map((child) => child.label), EXPECTED_SET_DO);
  assert.equal(NAVIGATION.primary.some((item) => item.href === "/shop" || item.label === "Trang chủ"), false);
});

test("every active primary and footer href resolves and obsolete links are absent", () => {
  const hrefs = [...activePrimaryHrefs(), ...NAVIGATION.footer.map((item) => item.href)];
  assert.deepEqual(hrefs.filter((href) => !matchesStorefrontRoute(href)), []);
  assert.equal(hrefs.includes("/lookbook"), false);
  assert.equal(hrefs.includes("/flash-sale"), false);
});

test("sale uses the existing promotion projection", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = readFileSync(`${root}src/routes/sale.ts`, "utf8");
  assert.match(source, /listConfiguredFlashSalePage/);
  assert.doesNotMatch(source, /listConfiguredStorefrontDiscoveryPage/);
});
