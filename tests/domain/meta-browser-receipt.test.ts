import assert from "node:assert/strict";
import test from "node:test";
import { issueMetaBrowserReceipt, verifyMetaBrowserReceipt, readMetaPagePath } from "../../src/commerce/meta-browser-receipt.ts";
import { buildCommittedMetaAddToCart } from "../../src/commerce/meta-pixel-parameters.ts";
import { createStorefrontCartPublicActions } from "../../src/commerce/storefront-cart-public-actions.ts";

const secret = "synthetic-meta-test-secret-32-characters";
const now = new Date("2026-10-07T03:00:00Z");
const facts = { name: "InitiateCheckout" as const, path: "/checkout",
  parameters: { content_ids: ["ao-dai"], currency: "VND" as const, value: 99_000 } };

test("rendered facts survive a valid receipt; changing name/items/price invalidates it", () => {
  const receipt = issueMetaBrowserReceipt(facts, secret, now);
  assert.deepEqual(verifyMetaBrowserReceipt(receipt, secret, now), facts);
  const [body, sig] = receipt.split(".");
  for (const tamper of [{ name: "Purchase" }, { parameters: { value: 1 } }, { path: "/admin" }]) {
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString());
    const changed = Buffer.from(JSON.stringify({ ...decoded, ...tamper })).toString("base64url");
    assert.equal(verifyMetaBrowserReceipt(`${changed}.${sig}`, secret, now), null);
  }
  assert.equal(verifyMetaBrowserReceipt(receipt, "wrong-key", now), null);
  assert.equal(verifyMetaBrowserReceipt(receipt, secret, new Date(now.getTime() + 16 * 60_000)), null);
  assert.equal(verifyMetaBrowserReceipt(receipt, secret, new Date(now.getTime() - 1)), null);
  assert.equal(verifyMetaBrowserReceipt("x".repeat(25_000), secret, now), null);
});

test("PageView signal cannot place arbitrary queries, credentials or private routes into Meta URLs", () => {
  for (const path of ["https://evil.test/", "//evil.test", "/checkout?phone=123", "/admin/products", "/api/meta/events", "/account", "/login", "/../admin"]) {
    assert.equal(readMetaPagePath(path), null, path);
  }
  assert.equal(readMetaPagePath("/shop/ao-dai"), "/shop/ao-dai");
  assert.equal(readMetaPagePath("/"), "/");
});

test("a committed Meta add reports delta money and quantities without internal identity", () => {
  const event = buildCommittedMetaAddToCart({ unitPriceVnd: 350_000, metaContentId: "ao-dai", metaContentName: "Áo dài" }, 3)!;
  assert.equal(event.parameters.value, 1_050_000);
  assert.equal(event.parameters.num_items, 3);
  assert.deepEqual(event.parameters.contents, [{ id: "ao-dai", quantity: 3, item_price: 350_000 }]);
  assert.equal(buildCommittedMetaAddToCart({ unitPriceVnd: 350_000 }, 3), undefined);
  assert.equal(buildCommittedMetaAddToCart({ unitPriceVnd: 350_000, metaContentId: "ao-dai" }, 0), undefined);
});

test("absolute cart edits report Meta only for positive server deltas, independent of canonical item availability", async () => {
  for (const quantity of [2, 4, 7]) {
    const actions = createStorefrontCartPublicActions({
      getLines: async () => [{ variantId: "internal-variant", available: true }],
      canSetQuantity: async () => true,
      setQuantity: async () => ({ ok: true, previousQuantity: 4, item: { quantity },
        snapshot: { unitPriceVnd: 100, metaContentId: "ao-dai", metaContentName: "", analyticsItem: null } }),
      remove: async () => ({ ok: false }),
    });
    const result = await actions.update({ variantId: "internal-variant", quantity, event_name: "Purchase", value: 1 });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.metaEvent?.parameters.num_items, quantity > 4 ? quantity - 4 : undefined);
    assert.equal(result.metaEvent?.parameters.value, quantity > 4 ? (quantity - 4) * 100 : undefined);
    assert.equal((JSON.stringify(result.metaEvent) ?? "").includes("internal-variant"), false);
  }
});
