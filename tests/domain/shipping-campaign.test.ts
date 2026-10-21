import assert from "node:assert/strict";
import test from "node:test";
import { calculateGuestShippingFeeVnd, readGuestShippingPolicy } from "../../src/commerce/guest-shipping-policy.ts";
import { evaluateShippingCampaigns, validateShippingCampaign, type ShippingCampaign } from "../../src/commerce/shipping-campaign.ts";

const now = new Date("2026-10-20T10:00:00Z");
const policy = { feeVnd: 30_000 };
const scope = { mode: "DYNAMIC_CATEGORY" as const, categoryKeys: ["aoDai", "setDo", "vayDam"], includeProductIds: [], excludeProductIds: [] };
const campaign = (patch: Partial<ShippingCampaign> = {}): ShippingCampaign => ({
  id: "shipping-two", name: "Two eligible paid units", revision: 1, isEnabled: true,
  enabledAt: new Date("2026-10-19T00:00:00Z"), disabledAt: null,
  startsAt: new Date("2026-10-20T00:00:00Z"), endsAt: new Date("2026-10-21T00:00:00Z"),
  minimumQuantity: 2, priority: 0, stackingEnabled: false, scope, ...patch,
});
const paid = (quantity = 2, categoryKeys = ["aoDaiTet"], productId = "product-a") => ({ role: "PAID" as const, product: { productId, categoryKeys }, quantity });
const quote = (campaigns: ShippingCampaign[], lines = [paid()], hasOtherPromotions = false, clock = now) =>
  evaluateShippingCampaigns({ campaigns, lines, hasOtherPromotions, now: clock, policy });

test("base shipping has no permanent quantity or subtotal waiver, even with stale environment values", () => {
  const configured = readGuestShippingPolicy({ LA_SHIPPING_FEE_VND: "25000", LA_FREE_SHIPPING_MIN_QUANTITY: "3", LA_FREE_SHIPPING_SUBTOTAL_VND: "1000000", LA_FREE_SHIPPING_MIN_SET_QUANTITY: "2" });
  assert.deepEqual(configured, { feeVnd: 25_000 });
  for (const [subtotalVnd, totalQuantity] of [[600_000, 3], [1_500_000, 1], [900_000, 2]]) {
    assert.equal(calculateGuestShippingFeeVnd({ subtotalVnd, totalQuantity }, configured), 25_000);
  }
  assert.equal(quote([]).feeVnd, 30_000);
});

test("an enabled campaign waives the base fee only at its configured paid threshold", () => {
  assert.equal(quote([campaign()], [paid(1)]).feeVnd, 30_000);
  const result = quote([campaign()]);
  assert.equal(result.feeVnd, 0);
  assert.equal(result.baseFeeVnd, 30_000);
  assert.equal(result.campaign?.id, "shipping-two");
  assert.equal(result.campaign?.revision, 1);
  assert.equal(result.campaign?.qualifyingQuantity, 2);
  assert.equal(quote([campaign({ minimumQuantity: 3, revision: 2 })]).feeVnd, 30_000);
});

test("a gift never raises eligible paid quantity", () => {
  const result = evaluateShippingCampaigns({ policy, now, hasOtherPromotions: true, campaigns: [campaign({ stackingEnabled: true })], lines: [paid(1), { ...paid(9), role: "GIFT" }] });
  assert.equal(result.feeVnd, 30_000);
});

test("each shipping campaign owns its scope and canonical category descendants", () => {
  assert.equal(quote([campaign()], [paid(1), paid(1, ["setQuanAo"], "product-b")]).feeVnd, 0);
  assert.equal(quote([campaign()], [paid(2, ["phuKien"])]).feeVnd, 30_000);
  assert.equal(quote([campaign({ scope: { ...scope, categoryKeys: ["aoDai"] } })], [paid(1), paid(1, ["setQuanAo"], "product-b")]).feeVnd, 30_000);
});

test("explicit exclusions win over categories and included products", () => {
  const ownScope = { ...scope, includeProductIds: ["accessory"], excludeProductIds: ["product-a"] };
  assert.equal(quote([campaign({ scope: ownScope })], [paid()]).feeVnd, 30_000);
  assert.equal(quote([campaign({ scope: ownScope })], [paid(2, ["phuKien"], "accessory")]).feeVnd, 0);
});

test("campaigns are off when disabled, future or expired; starts are inclusive and ends exclusive", () => {
  assert.equal(quote([campaign({ isEnabled: false })]).feeVnd, 30_000);
  assert.equal(quote([campaign({ startsAt: new Date(now.getTime() + 1) })]).feeVnd, 30_000);
  assert.equal(quote([campaign({ startsAt: now })]).feeVnd, 0);
  assert.equal(quote([campaign({ endsAt: now })]).feeVnd, 30_000);
});

test("merchandise/gift benefits are never silently removed to grant shipping; stacking is explicit", () => {
  assert.equal(quote([campaign()], [paid()], true).feeVnd, 30_000);
  assert.equal(quote([campaign({ stackingEnabled: true })], [paid()], true).feeVnd, 0);
});

test("multiple shipping campaigns grant one waiver in deterministic priority and ID order", () => {
  const a = campaign({ id: "a", priority: 2 });
  const b = campaign({ id: "b", priority: 1 });
  assert.equal(quote([a, b]).campaign?.id, "b");
  assert.equal(quote([b, a]).campaign?.id, "b");
  assert.equal(quote([b, campaign({ id: "a", priority: 1 })]).campaign?.id, "a");
  assert.equal(quote([a, b]).feeVnd, 0);
});

test("invalid campaign rules and unsafe quantities fail closed, not as no campaign", () => {
  for (const minimumQuantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateShippingCampaign({ ...campaign(), minimumQuantity }).ok, false);
  }
  assert.equal(validateShippingCampaign({ ...campaign(), endsAt: new Date("2020-01-01") }).ok, false);
  assert.equal(validateShippingCampaign({ ...campaign(), scope: { ...scope, categoryKeys: ["unknown"] } }).ok, false);
  assert.throws(() => quote([campaign({ minimumQuantity: 0 })]), /shipping/i);
  assert.throws(() => quote([campaign()], [paid(Number.MAX_SAFE_INTEGER + 1)]), /shipping/i);
  assert.throws(() => quote(Array.from({ length: 51 }, (_, i) => campaign({ id: `c-${i}` }))), /shipping/i);
});
