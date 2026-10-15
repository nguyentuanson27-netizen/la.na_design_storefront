/**
 * Which shops may receive a benefit order (GQ20).
 *
 * A benefit order is sent to Pancake as several lines of one variation at different unit prices (two
 * PAID segments, or a deducted PAID unit next to a 1.000đ gift unit). Whether the create-order API
 * keeps such lines apart is a vendor behaviour the project has not been entitled to assume: it is
 * proven per shop by the GQ01 acceptance run (`docs/integrations/pancake-gift-quantity-acceptance.md`),
 * and only a shop listed here has that evidence. For any other shop the benefit path stays closed --
 * the order is held at DRAFT, nothing is read from or sent to Pancake -- while the legacy path, which
 * never repeats a variation, is untouched.
 *
 * The list is configuration, not code, because acceptance is an operator act performed per shop.
 */

export const LINE_LEVEL_PRICING_VERIFIED_SHOPS_ENV = "LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS";

/** Parses `"715077776,123"`; anything that is not a positive safe integer is ignored (fail closed). */
export function readLineLevelPricingVerifiedShopIds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly number[] {
  const raw = env[LINE_LEVEL_PRICING_VERIFIED_SHOPS_ENV];
  if (typeof raw !== "string") return [];
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (!/^[1-9][0-9]{0,14}$/.test(text)) continue;
    const id = Number(text);
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
