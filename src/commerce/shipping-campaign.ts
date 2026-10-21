import { buildScopeResolver, validateScopeConfig, type ScopeConfig, type ScopeProductFacts } from "./gift-quantity-scope.ts";
import { calculateGuestShippingFeeVnd, type GuestShippingPolicy } from "./guest-shipping-policy.ts";
import { deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";
import { normalizePromotionCampaignName } from "./promotion-campaign-name.ts";

export const MAX_SHIPPING_CAMPAIGNS = 50;
export const MAX_SHIPPING_MINIMUM_QUANTITY = 10_000;
export const MAX_SHIPPING_PRIORITY = 1_000_000;
export const MAX_SHIPPING_QUOTE_LINES = 200;

export type ShippingCampaignValues = Readonly<{
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  minimumQuantity: number;
  priority: number;
  stackingEnabled: boolean;
  scope: Exclude<ScopeConfig, Readonly<{ mode: "GLOBAL_ALL_PAID_LINES" }>>;
}>;

export type ShippingCampaign = ShippingCampaignValues & Readonly<{
  id: string;
  revision: number;
  isEnabled: boolean;
  enabledAt: Date | null;
  disabledAt: Date | null;
}>;

export type ShippingCampaignIssue = "NAME_INVALID" | "WINDOW_INVALID" | "QUANTITY_INVALID" | "PRIORITY_INVALID" | "STACKING_INVALID" | "SCOPE_INVALID";
export type ShippingQuote = Readonly<{
  baseFeeVnd: number;
  feeVnd: number;
  campaign: Readonly<{ id: string; revision: number; name: string; minimumQuantity: number; qualifyingQuantity: number }> | null;
}>;
export type ShippingCampaignLine = Readonly<{ role: "PAID" | "GIFT"; product: ScopeProductFacts; quantity: number }>;

function validDate(value: unknown): value is Date | null {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

/** Validates admin rules and persisted rules alike. No default threshold, category or enabled campaign. */
export function validateShippingCampaign(input: unknown):
  | Readonly<{ ok: true; value: ShippingCampaignValues }>
  | Readonly<{ ok: false; reason: ShippingCampaignIssue }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "NAME_INVALID" };
  const raw = input as Record<string, unknown>;
  const name = normalizePromotionCampaignName(raw.name);
  if (!name.ok) return { ok: false, reason: "NAME_INVALID" };
  if (!validDate(raw.startsAt) || !validDate(raw.endsAt) || (raw.startsAt !== null && raw.endsAt !== null && raw.startsAt >= raw.endsAt)) return { ok: false, reason: "WINDOW_INVALID" };
  if (typeof raw.minimumQuantity !== "number" || !Number.isSafeInteger(raw.minimumQuantity) || raw.minimumQuantity < 1 || raw.minimumQuantity > MAX_SHIPPING_MINIMUM_QUANTITY) return { ok: false, reason: "QUANTITY_INVALID" };
  if (typeof raw.priority !== "number" || !Number.isSafeInteger(raw.priority) || raw.priority < 0 || raw.priority > MAX_SHIPPING_PRIORITY) return { ok: false, reason: "PRIORITY_INVALID" };
  if (typeof raw.stackingEnabled !== "boolean") return { ok: false, reason: "STACKING_INVALID" };
  const scope = validateScopeConfig(raw.scope, { allowGlobal: false });
  // v1 supports current category membership plus explicit products, not a second frozen-set lifecycle.
  if (!scope.ok || scope.scope.mode !== "DYNAMIC_CATEGORY") return { ok: false, reason: "SCOPE_INVALID" };
  return { ok: true, value: Object.freeze({ name: name.name, startsAt: raw.startsAt, endsAt: raw.endsAt, minimumQuantity: raw.minimumQuantity, priority: raw.priority, stackingEnabled: raw.stackingEnabled, scope: scope.scope }) };
}

/** One fee decision from one clock and server-owned paid lines; gifts and other campaigns never define its scope. */
export function evaluateShippingCampaigns({ campaigns, lines, policy, now, hasOtherPromotions }: Readonly<{
  campaigns: readonly ShippingCampaign[];
  lines: readonly ShippingCampaignLine[];
  policy: GuestShippingPolicy;
  now: Date;
  hasOtherPromotions: boolean;
}>): ShippingQuote {
  const baseFeeVnd = calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof hasOtherPromotions !== "boolean" || !Array.isArray(campaigns) || campaigns.length > MAX_SHIPPING_CAMPAIGNS || !Array.isArray(lines) || lines.length > MAX_SHIPPING_QUOTE_LINES) throw new RangeError("Invalid shipping evaluation input");
  let paidQuantity = 0;
  for (const line of lines) {
    if ((line.role !== "PAID" && line.role !== "GIFT") || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || !line.product || typeof line.product.productId !== "string" || line.product.productId.length < 1 || line.product.productId.length > 64 || !Array.isArray(line.product.categoryKeys) || line.product.categoryKeys.some((key: unknown) => typeof key !== "string")) throw new RangeError("Invalid shipping line");
    if (line.role === "PAID") paidQuantity += line.quantity;
    if (!Number.isSafeInteger(paidQuantity)) throw new RangeError("Shipping paid quantity overflow");
  }
  const seen = new Set<string>();
  const normalized = campaigns.map((campaign) => {
    const validated = validateShippingCampaign(campaign);
    if (!validated.ok || !/^[A-Za-z0-9_-]{1,64}$/.test(campaign.id) || seen.has(campaign.id) || !Number.isSafeInteger(campaign.revision) || campaign.revision < 1 || campaign.revision > 2_147_483_647 || typeof campaign.isEnabled !== "boolean" || !validDate(campaign.enabledAt) || !validDate(campaign.disabledAt)) throw new RangeError("Invalid shipping campaign");
    seen.add(campaign.id);
    return { ...campaign, ...validated.value };
  }).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const campaign of normalized) {
    if (deriveCampaignLifecycle({ ...campaign, now }).status !== "ACTIVE" || (hasOtherPromotions && !campaign.stackingEnabled)) continue;
    const matches = buildScopeResolver(campaign.scope, null);
    const qualifyingQuantity = lines.reduce((sum, line) => line.role === "PAID" && matches(line.product) ? sum + line.quantity : sum, 0);
    if (qualifyingQuantity < campaign.minimumQuantity) continue;
    return Object.freeze({ baseFeeVnd, feeVnd: 0, campaign: Object.freeze({ id: campaign.id, revision: campaign.revision, name: campaign.name, minimumQuantity: campaign.minimumQuantity, qualifyingQuantity }) });
  }
  return Object.freeze({ baseFeeVnd, feeVnd: baseFeeVnd, campaign: null });
}

/** Internal quote projection only. Public actions never accept this object from a browser. */
export function shippingFeeFromQuote(quote: ShippingQuote | undefined, policy: GuestShippingPolicy): number {
  const base = calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  if (quote === undefined) return base;
  if (quote === null || typeof quote !== "object" || (quote.campaign !== null && (
    !quote.campaign || !/^[A-Za-z0-9_-]{1,64}$/.test(quote.campaign.id) ||
    !Number.isSafeInteger(quote.campaign.revision) || quote.campaign.revision < 1 ||
    !Number.isSafeInteger(quote.campaign.minimumQuantity) || quote.campaign.minimumQuantity < 1 ||
    !Number.isSafeInteger(quote.campaign.qualifyingQuantity) || quote.campaign.qualifyingQuantity < quote.campaign.minimumQuantity
  ))) throw new RangeError("Invalid shipping quote");
  if (quote.baseFeeVnd !== base || quote.feeVnd !== (quote.campaign === null ? base : 0)) throw new RangeError("Shipping quote disagrees with its base policy");
  return quote.feeVnd;
}
