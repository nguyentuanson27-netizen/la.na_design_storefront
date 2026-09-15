import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

/**
 * Every rule in this file is type A or B: banned English buyer copy, and the Vietnamese copy that
 * must be there instead. None of it carries the brand name, so none of it broke under the template
 * and none of it needed converting -- the classification is recorded here so the next reader does
 * not have to re-derive it. The banned strings are split and rejoined so this file does not itself
 * contain the literals the repo-wide inventory scan bans.
 */
test("U1c cart finishes the Vietnamese transactional language contract", async () => {
  const cartSource = await readFile(join(REPO_ROOT, "src/app/cart/page.tsx"), "utf8");

  const oldBagHeading = ["YOUR", " BAG"].join("");
  const oldContinueShopping = ["Continue", " shopping"].join("");
  const oldVariantFallback = ["Color / Size", " unavailable"].join("");
  const oldColorSize = ["Color", " × Size"].join("");

  assert.equal(occurrences(cartSource, "GIỎ HÀNG"), 2, "cart empty and populated H1 must both be GIỎ HÀNG");
  assert.equal(cartSource.includes(oldBagHeading), false, "cart retained the old English bag heading");
  assert.equal(cartSource.includes("Tiếp tục mua sắm ↗"), true, "cart populated state missing Vietnamese continue-shopping link");
  assert.equal(cartSource.includes(oldContinueShopping), false, "cart retained English continue-shopping copy");
  assert.equal(cartSource.includes("Màu / Kích cỡ không khả dụng"), true, "cart missing Vietnamese variant fallback");
  assert.equal(cartSource.includes(oldVariantFallback), false, "cart retained English variant fallback");

  for (const expected of [
    "Màu × kích cỡ chưa hoàn tất",
    "Màu × kích cỡ đang bị trùng",
  ]) {
    assert.equal(cartSource.includes(expected), true, `cart missing Vietnamese unavailable-state copy: ${expected}`);
  }

  assert.equal(
    cartSource.includes(oldColorSize),
    false,
    "cart retained English option-matrix unavailable-state copy",
  );
});
