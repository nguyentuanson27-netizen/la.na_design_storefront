import {
  priceTier,
  validateTierConfig,
  type QuantityTierConfig,
  type TierPriceSegment,
} from "./gift-quantity-tier.ts";
import type { ScopeProductFacts, ScopeResolver } from "./gift-quantity-scope.ts";
import { applyPercentage, type PromotionCampaignKind } from "./promotion-pricing.ts";

/**
 * Gift & Quantity Promotions v1 (GQ07): the stacking orchestrator.
 *
 * Pure. It takes the per-line price the legacy resolver already produced, the tier campaigns that
 * are active for the cart, and the stacking consents, and returns the final paid price groups with
 * an ordered discount ledger. It never reads storage, a clock or the feature gate: a caller that
 * has the gate OFF simply never calls it, which is what keeps legacy pricing byte-for-byte as is.
 *
 * Decisions (ADR 0016):
 * - D-01: two campaigns stack only when BOTH allow each other. A legacy campaign has no stacking
 *   configuration of its own, so it stacks only if a consent exists for it (`legacyConsents`); with
 *   no consent it simply keeps the price the legacy resolver gave it, and the tier steps aside.
 *   Priorities must be unique among campaigns acting on the same unit; a tie or a missing priority
 *   is a conflict and fails closed -- the new campaign is dropped, never picked at random.
 * - D-02: a legacy `FIXED_PRICE` inside a stack is a price ceiling, `min(current, fixed)`.
 * - D-06: percentages round half-up per unit (shared with the legacy resolver).
 * - Spec FR-07/FR-10: when a tier turns out to be `TIER_PRICE_INVALID`, that whole tier is dropped
 *   and the chain is re-run from the same inputs, so every tier and stack downstream is recomputed
 *   on the corrected prices. The re-run uses the same `now`, scope and price snapshot.
 *
 * Dropping is conservative and cart-wide: a conflict is decided per campaign pair on the current
 * cart, and the new campaign loses to legacy; two new campaigns in conflict both lose.
 */

/** Stack peer wildcard: every campaign of that kind. */
export const STACK_PEER_ANY = "*";

export type StackPeerKind = PromotionCampaignKind | "QUANTITY_TIER" | "GIFT_ITEM";

export type StackPeer = Readonly<{ kind: StackPeerKind; campaignId: string }>;

export type StackLegacyCampaign = Readonly<{
  id: string;
  kind: PromotionCampaignKind;
  discountType: "PERCENTAGE" | "FIXED_PRICE";
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
}>;

export type StackInputLine = Readonly<{
  /** Stable identity of the source line within this call; never a cart id or PII. */
  lineKey: string;
  pancakeVariationId: string;
  quantity: number;
  product: ScopeProductFacts;
  /** The catalog price the legacy resolver started from, whole VND >= 1. */
  basePriceVnd: number;
  /**
   * What the legacy resolver decided at the base price: the single discounting campaign and the
   * price it produced. Null when no legacy campaign discounts this variant (including a legacy
   * conflict, which legacy resolves to "no promotion").
   */
  legacy: Readonly<{ campaign: StackLegacyCampaign; effectivePriceVnd: number }> | null;
}>;

export type StackTierParticipant = Readonly<{
  id: string;
  config: QuantityTierConfig;
  /** Scope membership for a product, built by `buildScopeResolver`. */
  resolve: ScopeResolver;
  /** Lower runs first. Required whenever the tier shares a unit with another campaign. */
  priority: number | null;
  stackingEnabled: boolean;
  peers: readonly StackPeer[];
}>;

export type StackLegacyConsent = ReadonlyMap<string, Readonly<{ priority: number }>>;

export type StackStep = Readonly<{
  campaignId: string;
  source: "LEGACY" | "QUANTITY_TIER";
  kind: StackPeerKind;
  priority: number | null;
  inputPriceVnd: number;
  outputPriceVnd: number;
  appliedQuantity: number;
}>;

export type StackedGroup = Readonly<{
  groupKey: string;
  lineKey: string;
  pancakeVariationId: string;
  quantity: number;
  basePriceVnd: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  steps: readonly StackStep[];
}>;

export type StackDropReason =
  | "STACK_NOT_PERMITTED"
  | "STACK_PRIORITY_CONFLICT"
  | "TIER_PRICE_INVALID"
  | "TIER_CONFIG_INVALID"
  | "TIER_INPUT_INVALID";

export type StackDroppedCampaign = Readonly<{
  campaignId: string;
  reason: StackDropReason;
  /** The other campaign in a pair conflict, when there is one. */
  otherCampaignId: string | null;
}>;

export type StackResult =
  | Readonly<{
      ok: true;
      groups: readonly StackedGroup[];
      subtotalVnd: number;
      dropped: readonly StackDroppedCampaign[];
    }>
  | Readonly<{ ok: false; reason: "INPUT_INVALID" }>;

type Mutable = {
  groupKey: string;
  lineKey: string;
  pancakeVariationId: string;
  product: ScopeProductFacts;
  quantity: number;
  basePriceVnd: number;
  unitPriceVnd: number;
  steps: StackStep[];
};

const MAX_STACK_LINES = 200;

/**
 * Caller-supplied line keys are a plain token. `|` is reserved: it joins a key to a split suffix
 * (`key|disc`, `key|full`), so a derived key can never collide with an original one.
 */
export const STACK_LINE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function validLine(line: StackInputLine): boolean {
  return (
    typeof line.lineKey === "string" &&
    STACK_LINE_KEY_PATTERN.test(line.lineKey) &&
    Number.isSafeInteger(line.quantity) &&
    line.quantity >= 1 &&
    Number.isSafeInteger(line.basePriceVnd) &&
    line.basePriceVnd >= 1 &&
    (line.legacy === null ||
      (Number.isSafeInteger(line.legacy.effectivePriceVnd) &&
        line.legacy.effectivePriceVnd >= 1 &&
        line.legacy.effectivePriceVnd <= line.basePriceVnd))
  );
}

/**
 * One legacy price step applied at a chain position. Percentages apply to the current price;
 * `FIXED_PRICE` is a ceiling (D-02), so it can never raise a price an earlier step lowered.
 * Returns null when the step cannot produce a valid price, in which case it is skipped.
 */
export function applyLegacyStackStep(campaign: StackLegacyCampaign, currentPriceVnd: number): number | null {
  if (!Number.isSafeInteger(currentPriceVnd) || currentPriceVnd < 1) return null;
  let next: number | null;
  if (campaign.discountType === "PERCENTAGE") {
    next = campaign.percentageValue === null ? null : applyPercentage(currentPriceVnd, campaign.percentageValue);
  } else {
    if (campaign.fixedPriceVnd === null || campaign.fixedPriceVnd <= BigInt(0)) return null;
    if (campaign.fixedPriceVnd > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    next = Math.min(currentPriceVnd, Number(campaign.fixedPriceVnd));
  }
  if (next === null || !Number.isSafeInteger(next) || next < 1 || next > currentPriceVnd) return null;
  return next;
}

/** Whether a ladder's configuration can price anything; the quote asks this through the stack, which owns the tier engine. */
export function isValidTierConfig(config: QuantityTierConfig): boolean {
  return validateTierConfig(config).length === 0;
}

/** Whether a peer list accepts a campaign of `kind` with `campaignId` (by id, or by kind with `*`). */
export function stackPeersAllow(peers: readonly StackPeer[], kind: StackPeerKind, campaignId: string): boolean {
  return peers.some((peer) => peer.kind === kind && (peer.campaignId === STACK_PEER_ANY || peer.campaignId === campaignId));
}

type Participant =
  | Readonly<{ source: "TIER"; id: string; tier: StackTierParticipant; priority: number | null }>
  | Readonly<{ source: "LEGACY"; id: string; campaign: StackLegacyCampaign; priority: number | null; consented: boolean }>;

type StackInput = Readonly<{
  lines: readonly StackInputLine[];
  tiers: readonly StackTierParticipant[];
  legacyConsents: StackLegacyConsent;
}>;

export function priceStack(input: StackInput): StackResult {
  if (!input.tiers.some(isOrderLadder)) return solveStack(input);

  // Which order-value ladders are reached depends on which campaigns end up applying, and which campaigns
  // end up applying can depend on which ladders were reached (a refused pair drops BOTH). So the two are
  // settled together: price the cart, set aside every campaign the run dropped, and judge the ladders again
  // on what is left, until a run drops nothing new. A campaign set aside stays aside (fail closed), and the
  // order the caller listed things in cannot matter because every step below sorts.
  const dropped = new Map<string, StackDroppedCampaign>();
  const excluded = new Set<string>();
  for (let attempt = 0; attempt <= input.tiers.length; attempt += 1) {
    const result = priceWithReachedLadders({ ...input, tiers: input.tiers.filter((tier) => !excluded.has(tier.id)) });
    if (!result.ok) return result;
    for (const entry of result.dropped) if (!dropped.has(entry.campaignId)) dropped.set(entry.campaignId, entry);
    const fresh = result.dropped.filter((entry) => entry.reason !== "TIER_CONFIG_INVALID" && !excluded.has(entry.campaignId));
    if (fresh.length === 0) {
      return { ...result, dropped: [...dropped.values()].sort((x, y) => (x.campaignId < y.campaignId ? -1 : x.campaignId > y.campaignId ? 1 : 0)) };
    }
    for (const entry of fresh) excluded.add(entry.campaignId);
  }
  // Unreachable: every pass sets aside at least one more campaign, and there are finitely many.
  return { ok: false, reason: "INPUT_INVALID" };
}

function isOrderLadder(tier: StackTierParticipant): boolean {
  return tier.config.basis === "ORDER_SUBTOTAL";
}

/**
 * One pass: an order-value ladder is judged on what the shopper would pay after every other step, so whether
 * it is reached is decided on the cart priced WITHOUT it, and only a ladder that really is reached joins
 * conflict detection (one that is not can never make a valid tier step aside). Ladders run last in
 * (priority, id) order, so each is judged on the cart as the ladders before it left it -- an earlier ladder
 * that brings the goods under a later one's rung leaves that later ladder idle.
 */
function priceWithReachedLadders(input: StackInput): StackResult {
  const nonLadders = input.tiers.filter((tier) => !isOrderLadder(tier));
  const productOf = new Map(input.lines.map((line) => [line.lineKey, line.product]));
  const inOrder = input.tiers.filter(isOrderLadder).sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    return pa !== pb ? pa - pb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const reached: StackTierParticipant[] = [];
  for (const tier of inOrder) {
    // A ladder with an invalid configuration is passed on so it is reported as such.
    if (validateTierConfig(tier.config).length > 0) {
      reached.push(tier);
      continue;
    }
    const before = solveStack({ ...input, tiers: [...nonLadders, ...reached] });
    if (!before.ok) return before;
    let goods = 0;
    for (const group of before.groups) if (tier.resolve(productOf.get(group.lineKey)!)) goods += group.lineTotalVnd;
    if (goods >= tier.config.tiers[0]!.minQuantity) reached.push(tier);
  }
  return solveStack({ ...input, tiers: [...nonLadders, ...reached] });
}

function solveStack(input: StackInput): StackResult {
  const { lines, tiers, legacyConsents } = input;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_STACK_LINES) return { ok: false, reason: "INPUT_INVALID" };
  const keys = new Set<string>();
  for (const line of lines) {
    if (!validLine(line) || keys.has(line.lineKey)) return { ok: false, reason: "INPUT_INVALID" };
    keys.add(line.lineKey);
  }
  const tierIds = new Set<string>();
  for (const tier of tiers) {
    if (tierIds.has(tier.id)) return { ok: false, reason: "INPUT_INVALID" };
    tierIds.add(tier.id);
  }

  // Deterministic regardless of the order the caller (or the database) listed things in.
  const sortedLines = [...lines].sort((a, b) => (a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0));
  const sortedByIdTiers = [...tiers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // A tier with an invalid configuration can price nothing, so it is set aside before any pairing:
  // it is reported as TIER_CONFIG_INVALID (kept in `dropped` for audit) and never makes a valid
  // campaign that merely shares a line with it step aside.
  const invalidConfigTiers = sortedByIdTiers.filter((tier) => validateTierConfig(tier.config).length > 0);
  const validConfigTiers = sortedByIdTiers.filter((tier) => validateTierConfig(tier.config).length === 0);

  // A tier whose in-scope paid quantity has not reached its first threshold changes no price, so it
  // takes no part in conflict detection: it can neither be dropped nor make another campaign drop.
  // Without this, an idle tier that merely shares a line with a valid one would cancel the valid
  // tier's discount. Quantity is independent of price, so this is decided once, up front.
  const sortedTiers = validConfigTiers.filter((tier) => {
    const startThreshold = tier.config.tiers[0]!.minQuantity;
    // An order-value ladder was already judged against the cart priced without it (see `priceStack`).
    if (tier.config.basis === "ORDER_SUBTOTAL") return true;
    let eligible = 0;
    for (const line of sortedLines) if (tier.resolve(line.product)) eligible += line.quantity;
    return eligible >= startThreshold;
  });

  const dropped = new Map<string, StackDroppedCampaign>();
  const drop = (campaignId: string, reason: StackDropReason, otherCampaignId: string | null) => {
    if (!dropped.has(campaignId)) dropped.set(campaignId, { campaignId, reason, otherCampaignId });
  };
  for (const tier of invalidConfigTiers) drop(tier.id, "TIER_CONFIG_INVALID", null);

  // Which lines each campaign touches.
  const tierLines = new Map<string, Set<string>>();
  for (const tier of sortedTiers) {
    tierLines.set(tier.id, new Set(sortedLines.filter((line) => tier.resolve(line.product)).map((line) => line.lineKey)));
  }
  const legacyById = new Map<string, StackLegacyCampaign>();
  const legacyLines = new Map<string, Set<string>>();
  for (const line of sortedLines) {
    if (line.legacy === null) continue;
    legacyById.set(line.legacy.campaign.id, line.legacy.campaign);
    const set = legacyLines.get(line.legacy.campaign.id) ?? new Set<string>();
    set.add(line.lineKey);
    legacyLines.set(line.legacy.campaign.id, set);
  }

  const participants = new Map<string, Participant>();
  for (const tier of sortedTiers) {
    participants.set(`T:${tier.id}`, { source: "TIER", id: tier.id, tier, priority: tier.priority });
  }
  for (const [id, campaign] of legacyById) {
    const consent = legacyConsents.get(id);
    participants.set(`L:${id}`, { source: "LEGACY", id, campaign, priority: consent?.priority ?? null, consented: consent !== undefined });
  }
  const linesOf = (p: Participant) => (p.source === "TIER" ? tierLines.get(p.id)! : legacyLines.get(p.id)!);
  const share = (a: Participant, b: Participant) => {
    const bLines = linesOf(b);
    for (const key of linesOf(a)) if (bLines.has(key)) return true;
    return false;
  };

  // Pairwise compatibility on the lines the pair actually shares. Evaluated once, on the original
  // participants, so the outcome never depends on the order conflicts are discovered in.
  const all = [...participants.values()];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.source === "LEGACY" && b.source === "LEGACY") continue;
      if (!share(a, b)) continue;

      const compatible = (x: Participant, y: Participant): boolean => {
        if (x.source === "TIER") {
          if (!x.tier.stackingEnabled) return false;
          return stackPeersAllow(x.tier.peers, y.source === "TIER" ? "QUANTITY_TIER" : y.campaign.kind, y.id);
        }
        // A legacy campaign's own consent. Its peers are the tier campaigns that name it.
        return x.consented;
      };
      const ok = compatible(a, b) && compatible(b, a);
      const tiersOf = [a, b].filter((p) => p.source === "TIER");
      const other = (p: Participant) => (p === a ? b.id : a.id);

      if (!ok) {
        // New yields to legacy; two new campaigns that may not stack drop each other.
        for (const tier of tiersOf) drop(tier.id, "STACK_NOT_PERMITTED", other(tier));
        continue;
      }
      if (a.priority === null || b.priority === null || a.priority === b.priority) {
        for (const tier of tiersOf) drop(tier.id, "STACK_PRIORITY_CONFLICT", other(tier));
      }
    }
  }

  const alive = (id: string) => !dropped.has(id);

  // Run the chain; a tier that proves invalid is dropped and the whole chain re-run.
  for (let attempt = 0; attempt <= sortedTiers.length; attempt += 1) {
    const activeTiers = sortedTiers.filter((tier) => alive(tier.id));

    // Legacy campaigns that sit in the chain: they share a line with a surviving tier.
    const chainLegacy = new Set<string>();
    for (const [id] of legacyById) {
      const legacyParticipant = participants.get(`L:${id}`)!;
      for (const tier of activeTiers) {
        if (share(legacyParticipant, participants.get(`T:${tier.id}`)!)) chainLegacy.add(id);
      }
    }

    const groups: Mutable[] = sortedLines.map((line) => {
      const inChain = line.legacy !== null && chainLegacy.has(line.legacy.campaign.id);
      const steps: StackStep[] = [];
      let price = line.basePriceVnd;
      if (line.legacy !== null && !inChain) {
        price = line.legacy.effectivePriceVnd;
        if (price !== line.basePriceVnd) {
          steps.push({
            campaignId: line.legacy.campaign.id, source: "LEGACY", kind: line.legacy.campaign.kind,
            priority: legacyConsents.get(line.legacy.campaign.id)?.priority ?? null,
            inputPriceVnd: line.basePriceVnd, outputPriceVnd: price, appliedQuantity: line.quantity,
          });
        }
      }
      return {
        groupKey: line.lineKey, lineKey: line.lineKey, pancakeVariationId: line.pancakeVariationId,
        product: line.product, quantity: line.quantity, basePriceVnd: line.basePriceVnd, unitPriceVnd: price, steps,
      };
    });

    // An order-value ladder always runs last, whatever its priority: its threshold is "what the shopper
    // would pay for goods", which only exists once every other step has priced the lines.
    const rankOf = (tier: StackTierParticipant) => (tier.config.basis === "ORDER_SUBTOTAL" ? 1 : 0);
    const chain = [
      ...activeTiers.map((tier) => ({ source: "TIER" as const, id: tier.id, priority: tier.priority, rank: rankOf(tier) })),
      ...[...chainLegacy].map((id) => ({ source: "LEGACY" as const, id, priority: legacyConsents.get(id)!.priority, rank: 0 })),
    ].sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Tiers that share nothing may have no priority; they sort last, then by id.
      const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    let restart = false;
    let working = groups;
    for (const step of chain) {
      if (step.source === "LEGACY") {
        const campaign = legacyById.get(step.id)!;
        const touched = legacyLines.get(step.id)!;
        for (const group of working) {
          if (!touched.has(group.lineKey)) continue;
          const next = applyLegacyStackStep(campaign, group.unitPriceVnd);
          if (next === null || next === group.unitPriceVnd) continue;
          group.steps.push({
            campaignId: campaign.id, source: "LEGACY", kind: campaign.kind, priority: step.priority,
            inputPriceVnd: group.unitPriceVnd, outputPriceVnd: next, appliedQuantity: group.quantity,
          });
          group.unitPriceVnd = next;
        }
        continue;
      }

      const tier = activeTiers.find((candidate) => candidate.id === step.id)!;
      const inScope = working.filter((group) => tier.resolve(group.product));
      if (inScope.length === 0) continue;
      const result = priceTier(
        tier.config,
        inScope.map((group) => ({
          lineKey: group.groupKey,
          pancakeVariationId: group.pancakeVariationId,
          quantity: group.quantity,
          unitPriceVnd: group.unitPriceVnd,
        })),
      );
      if (result.status === "NOT_REACHED") continue;
      if (result.status !== "APPLIED") {
        const reason: StackDropReason =
          result.status === "TIER_PRICE_INVALID" ? "TIER_PRICE_INVALID" : result.status === "INVALID_CONFIG" ? "TIER_CONFIG_INVALID" : "TIER_INPUT_INVALID";
        drop(tier.id, reason, null);
        restart = true;
        break;
      }

      const bySource = new Map(inScope.map((group) => [group.groupKey, group]));
      const replaced = new Map<string, Mutable[]>();
      const segmentsPerSource = new Map<string, number>();
      for (const segment of result.segments as readonly TierPriceSegment[]) {
        segmentsPerSource.set(segment.lineKey, (segmentsPerSource.get(segment.lineKey) ?? 0) + 1);
      }
      for (const segment of result.segments as readonly TierPriceSegment[]) {
        const origin = bySource.get(segment.lineKey)!;
        const list = replaced.get(origin.groupKey) ?? [];
        const steps = [...origin.steps];
        if (segment.discounted) {
          steps.push({
            campaignId: tier.id, source: "QUANTITY_TIER", kind: "QUANTITY_TIER", priority: tier.priority,
            inputPriceVnd: segment.unitPriceBeforeVnd, outputPriceVnd: segment.unitPriceVnd, appliedQuantity: segment.quantity,
          });
        }
        list.push({
          // A source this tier left whole keeps its key, so keys only change where a split happened.
          groupKey: segmentsPerSource.get(segment.lineKey) === 1 && !segment.discounted ? origin.groupKey : segment.segmentKey,
          lineKey: origin.lineKey, pancakeVariationId: origin.pancakeVariationId, product: origin.product,
          quantity: segment.quantity, basePriceVnd: origin.basePriceVnd, unitPriceVnd: segment.unitPriceVnd, steps,
        });
        replaced.set(origin.groupKey, list);
      }
      working = working.flatMap((group) => replaced.get(group.groupKey) ?? [group]);
    }

    if (restart) continue;

    const finalGroups: StackedGroup[] = working.map((group) => ({
      groupKey: group.groupKey,
      lineKey: group.lineKey,
      pancakeVariationId: group.pancakeVariationId,
      quantity: group.quantity,
      basePriceVnd: group.basePriceVnd,
      unitPriceVnd: group.unitPriceVnd,
      lineTotalVnd: group.unitPriceVnd * group.quantity,
      steps: group.steps,
    }));
    const subtotalVnd = finalGroups.reduce((sum, group) => sum + group.lineTotalVnd, 0);
    if (!Number.isSafeInteger(subtotalVnd)) return { ok: false, reason: "INPUT_INVALID" };
    return {
      ok: true,
      groups: finalGroups,
      subtotalVnd,
      dropped: [...dropped.values()].sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0)),
    };
  }

  // Unreachable: every restart drops at least one tier, and there are finitely many.
  return { ok: false, reason: "INPUT_INVALID" };
}

export type GiftStackCandidate = Readonly<{
  id: string;
  stackingEnabled: boolean;
  peers: readonly StackPeer[];
  minimumQuantity?: number | null;
  minimumSubtotalVnd?: number | bigint | null;
  stackPriority?: number | null;
}>;

export type GiftStackResolution = Readonly<{
  /** Campaigns that may run together on this cart, in id order. */
  permitted: readonly string[];
  /** Campaigns that stepped aside, with the other campaign in the refused pair. */
  dropped: readonly StackDroppedCampaign[];
}>;

/**
 * Compares precedence between two gift campaigns that cannot stack together.
 * - Explicit stackPriority (lower number wins)
 * - Higher threshold (higher minimumQuantity or minimumSubtotalVnd represents an upgraded milestone)
 * - 0 when tied or indeterminate (in which case both fail closed)
 */
function compareGiftPrecedence(a: GiftStackCandidate, b: GiftStackCandidate): number {
  if (
    typeof a.stackPriority === "number" &&
    typeof b.stackPriority === "number" &&
    a.stackPriority !== b.stackPriority
  ) {
    return a.stackPriority < b.stackPriority ? 1 : -1;
  }
  if (
    typeof a.minimumQuantity === "number" &&
    typeof b.minimumQuantity === "number" &&
    a.minimumQuantity !== b.minimumQuantity
  ) {
    return a.minimumQuantity > b.minimumQuantity ? 1 : -1;
  }
  const subA = typeof a.minimumSubtotalVnd === "bigint" ? Number(a.minimumSubtotalVnd) : a.minimumSubtotalVnd;
  const subB = typeof b.minimumSubtotalVnd === "bigint" ? Number(b.minimumSubtotalVnd) : b.minimumSubtotalVnd;
  if (typeof subA === "number" && typeof subB === "number" && subA !== subB) {
    return subA > subB ? 1 : -1;
  }
  return 0;
}

/**
 * Which of the gift campaigns that are all earning on one cart may run together (FR-08).
 *
 * A gift never changes a price, so there is no order to resolve; the only question is permission.
 * Two gift campaigns coexist only when **both** have stacking enabled and **each** names the other
 * (by id, or by the `GIFT_ITEM` wildcard). If a refused pair has a clear threshold/priority precedence,
 * the higher milestone/priority wins while the superseded campaign steps aside. When precedence is
 * tied or unspecified, any refused pair drops **both** campaigns (conservative fail-closed). A single
 * gift campaign always runs: with nothing to combine with, no permission is asked.
 */
export function resolveGiftCampaignStacking(campaigns: readonly GiftStackCandidate[]): GiftStackResolution {
  const sorted = [...campaigns].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dropped = new Map<string, StackDroppedCampaign>();
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const together =
        a.stackingEnabled && b.stackingEnabled &&
        stackPeersAllow(a.peers, "GIFT_ITEM", b.id) &&
        stackPeersAllow(b.peers, "GIFT_ITEM", a.id);
      if (together) continue;
      const precedence = compareGiftPrecedence(a, b);
      if (precedence > 0) {
        if (!dropped.has(b.id)) dropped.set(b.id, { campaignId: b.id, reason: "STACK_NOT_PERMITTED", otherCampaignId: a.id });
      } else if (precedence < 0) {
        if (!dropped.has(a.id)) dropped.set(a.id, { campaignId: a.id, reason: "STACK_NOT_PERMITTED", otherCampaignId: b.id });
      } else {
        if (!dropped.has(a.id)) dropped.set(a.id, { campaignId: a.id, reason: "STACK_NOT_PERMITTED", otherCampaignId: b.id });
        if (!dropped.has(b.id)) dropped.set(b.id, { campaignId: b.id, reason: "STACK_NOT_PERMITTED", otherCampaignId: a.id });
      }
    }
  }
  return {
    permitted: sorted.filter((campaign) => !dropped.has(campaign.id)).map((campaign) => campaign.id),
    dropped: sorted.filter((campaign) => dropped.has(campaign.id)).map((campaign) => dropped.get(campaign.id)!),
  };
}

/** Authoritative stage value, shared by progress and checkout +1 verification (including the top rung). */
export function orderValueTierInputSubtotal(groups: readonly StackedGroup[], id: string, order: readonly { id: string; priority: number | null }[]): number {
  const mine = order.find((tier) => tier.id === id);
  const myPriority = mine?.priority ?? Number.MAX_SAFE_INTEGER;
  const later = new Set(order.filter((tier) => (tier.priority ?? Number.MAX_SAFE_INTEGER) > myPriority
    || ((tier.priority ?? Number.MAX_SAFE_INTEGER) === myPriority && tier.id > id)).map((tier) => tier.id));
  return groups.reduce((sum, group) => {
    const ownStep = group.steps.find((step) => step.source === "QUANTITY_TIER" && step.campaignId === id);
    const laterStep = group.steps.find((step) => step.source === "QUANTITY_TIER" && later.has(step.campaignId));
    return sum + group.quantity * (ownStep?.inputPriceVnd ?? laterStep?.inputPriceVnd ?? group.unitPriceVnd);
  }, 0);
}
