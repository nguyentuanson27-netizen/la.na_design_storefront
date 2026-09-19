/**
 * The G5 capacity authority (ADR 0014).
 *
 * Two pure decisions live here, both of which the reservation implementation (I6a) and every
 * sellability consumer (I4/I5) must go through rather than re-deriving:
 *
 * 1. **May this quantity be reserved?** — the threshold rule per selling mode.
 * 2. **Does a reservation still hold capacity?** — the state machine, including the case that makes
 *    this subtle: an ambiguous Pancake write must keep holding.
 *
 * Nothing here touches the database. The transactional mechanics that make the check atomic are
 * I6a's, and ADR 0014 §6 specifies them; this module is the predicate those mechanics evaluate, so
 * the arithmetic can be tested exhaustively without a database and cannot drift between callers.
 *
 * Pancake is *not* the enforcement authority. G2 proved it accepts orders at stock 0, below 0, and
 * accepts two concurrent orders at stock 0 — so the local gate is the only thing standing between a
 * concurrent checkout and an unbounded negative balance.
 */

export const SELLING_MODES = ["STANDARD", "OVERSELL", "PREORDER"] as const;
export type SellingMode = (typeof SELLING_MODES)[number];

/** Master spec §27. Product-level, enforced independently per variant. */
export const DEFAULT_NEGATIVE_STOCK_LIMIT = -20;

/** A product with no stored policy sells as `STANDARD`. See `resolveSellingPolicy`. */
export const DEFAULT_SELLING_MODE: SellingMode = "STANDARD";

/** The stored shape, as `ProductSellingPolicy` would return it (ADR 0014 §13). */
export type StoredSellingPolicy = Readonly<{
  sellingMode: SellingMode;
  negativeStockLimit: number;
}>;

export type ResolvedSellingPolicy = Readonly<{
  sellingMode: SellingMode;
  negativeStockLimit: number;
  /** True when no stored row existed and the defaults were applied. */
  isDefault: boolean;
}>;

/**
 * The canonical selling policy for a product.
 *
 * **Absence is the common case, and it is not covered by a column default.** A column default only
 * fires when a row is inserted; a product with no `ProductSellingPolicy` row has no defaults applied
 * to it at all, because the database never invents the row. So "no backfill" is only safe if exactly
 * one resolver owns the missing-row answer and every consumer goes through it — otherwise each
 * call site invents its own, and they will disagree.
 *
 * No row means `STANDARD` with `DEFAULT_NEGATIVE_STOCK_LIMIT`, which reproduces today's behaviour
 * exactly. `isDefault` is reported so an admin surface can distinguish "not configured" from
 * "configured to the same values as the default" without a second query.
 *
 * A stored row is returned **as stored**, including values `evaluateVariantCapacity` will refuse
 * (a positive or fractional limit). Substituting the default for a bad stored value would silently
 * replace the limit the owner set with one they never approved; refusing the sale and naming
 * `invalid-limit` sends the operator to the row that is actually wrong.
 *
 * An unrecognized `sellingMode` is the one case that falls back rather than passing through: there
 * is no owner intent to preserve in a value that names no mode, so it resolves to the most
 * restrictive one. The stored limit is still preserved, so nothing about it is silently widened.
 */
export function resolveSellingPolicy(
  stored: StoredSellingPolicy | null | undefined,
): ResolvedSellingPolicy {
  if (stored === null || stored === undefined) {
    return Object.freeze({
      sellingMode: DEFAULT_SELLING_MODE,
      negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
      isDefault: true,
    });
  }

  const sellingMode = SELLING_MODES.includes(stored.sellingMode)
    ? stored.sellingMode
    : DEFAULT_SELLING_MODE;

  return Object.freeze({
    sellingMode,
    negativeStockLimit: stored.negativeStockLimit,
    isDefault: false,
  });
}

export type CapacityDecisionReason =
  | "capacity-available"
  | "invalid-quantity"
  | "invalid-limit"
  | "invalid-stock"
  | "standard-would-go-negative"
  | "negative-limit-reached"
  | "composite-oversell-unproven";

export type VariantCapacityInput = Readonly<{
  /** Mirrored Pancake stock for the variant, summed across warehouses. May already be negative. */
  mirroredStock: number;
  /**
   * Quantity held by reservations that still count (see `reservationHoldsCapacity`).
   *
   * Never negative. This is what makes two concurrent checkouts serialize: the second one sees the
   * first one's hold, because I6a computes it inside the same transaction that took the row lock.
   */
  activeReservedQuantity: number;
  sellingMode: SellingMode;
  /** Product-level limit, applied per variant. `STANDARD` ignores it; its floor is always 0. */
  negativeStockLimit: number;
  /** Composite parents are restricted in v1 — see below. */
  isComposite: boolean;
}>;

export type CapacityDecision = Readonly<{
  allowed: boolean;
  reason: CapacityDecisionReason;
  /** `mirroredStock - activeReservedQuantity - quantity`. Reported even when refused, for operators. */
  projectedCapacity: number;
  /** The value `projectedCapacity` may not go below. */
  floor: number;
}>;

/**
 * The lowest capacity a mode may reach.
 *
 * `STANDARD` may never go below 0 no matter what the limit says — the limit is an oversell/preorder
 * allowance, not a licence for standard products to go negative (master spec §28).
 */
export function capacityFloorForMode(mode: SellingMode, negativeStockLimit: number): number {
  return mode === "STANDARD" ? 0 : negativeStockLimit;
}

/**
 * Whether `quantity` more units of this variant may be reserved right now.
 *
 * Fail-closed on every malformed input: a non-integer or non-positive quantity, and a positive or
 * non-integer limit, are refusals rather than coerced values. A limit of `0` is legitimate and means
 * "oversell enabled but no negative allowance", so it is accepted.
 */
export function evaluateVariantCapacity(
  input: VariantCapacityInput,
  quantity: number,
): CapacityDecision {
  const floor = capacityFloorForMode(input.sellingMode, input.negativeStockLimit);
  const projectedCapacity = input.mirroredStock - input.activeReservedQuantity - quantity;

  const refuse = (reason: CapacityDecisionReason): CapacityDecision =>
    Object.freeze({ allowed: false, reason, projectedCapacity, floor });

  if (!Number.isSafeInteger(quantity) || quantity <= 0) return refuse("invalid-quantity");
  if (!Number.isSafeInteger(input.negativeStockLimit) || input.negativeStockLimit > 0) {
    return refuse("invalid-limit");
  }
  // `WarehouseStock.quantity` is `Float` in the mirror, so a fractional or non-finite sum is
  // reachable from upstream data. Capacity is a count: rather than floor it — which would silently
  // reinterpret stock the operator never approved — the variant stops selling and says why. This is
  // a distinct reason from `invalid-quantity` because the fault is in the mirror, not the request,
  // and an operator chasing it needs to be sent to the right place.
  if (!Number.isSafeInteger(input.mirroredStock)) return refuse("invalid-stock");
  if (!Number.isSafeInteger(input.activeReservedQuantity) || input.activeReservedQuantity < 0) {
    return refuse("invalid-stock");
  }

  // Composite v1 restriction. G2 exercised one 1:1 fixture and saw a child driven to -1; it proved
  // nothing about arbitrary multipliers, a child that starts negative, or multi-component
  // atomicity. Selling a composite below zero would consume component capacity this predicate does
  // not model, so it is refused until component-aware accounting exists and is proven by evidence.
  if (input.isComposite && input.sellingMode !== "STANDARD") {
    return refuse("composite-oversell-unproven");
  }

  if (projectedCapacity < floor) {
    return refuse(
      input.sellingMode === "STANDARD" ? "standard-would-go-negative" : "negative-limit-reached",
    );
  }

  return Object.freeze({ allowed: true, reason: "capacity-available", projectedCapacity, floor });
}

/**
 * The fulfillment state an accepted line of `quantity` units carries — the one rule, one place.
 *
 * Master spec §30 is about whether the buyer waits, and that depends on **how many units** they
 * are taking, not on whether one more could be sold. A `PREORDER` variant with one unit of ready
 * stock is a ready sale at quantity 1 and a preorder sale at quantity 2, because the second unit
 * has to be prepared.
 *
 * It exists because the answer was being derived twice from two different comparisons: the
 * reservation wrote `acceptedPreorderState` from `readyStock < quantity`, while the advisory
 * projections asked `resolveVariantSellability()`, whose answer is for one unit. A buyer taking
 * two of a one-in-stock preorder variant was therefore shown a ready-stock checkout and then had
 * `PREORDER` persisted into their immutable order history. Both callers now ask this.
 *
 * Purchasability is deliberately not considered here: this answers "if accepted, does it wait",
 * and whether it may be accepted at all is `evaluateVariantCapacity()`'s question.
 */
export function resolveAcceptedPreorderState(
  input: VariantCapacityInput,
  quantity: number,
): "READY" | "PREORDER" {
  const readyStock = input.mirroredStock - input.activeReservedQuantity;
  return input.sellingMode === "PREORDER" && readyStock < quantity ? "PREORDER" : "READY";
}

export type VariantSellability = Readonly<{
  /** Whether one more unit may be sold right now. */
  sellable: boolean;
  reason: CapacityDecisionReason;
  /**
   * Master spec §30's `Đặt trước`: a `PREORDER` variant that is still purchasable but no longer has
   * ready stock. Above 0 a preorder product sells normally and carries **no** marker; at or below 0
   * and above the limit it stays purchasable and the surface must say so.
   *
   * False whenever the variant is not sellable at all, so a surface cannot label something the
   * shopper cannot buy.
   */
  isPreorderSale: boolean;
  floor: number;
}>;

/**
 * Is this variant sellable right now, and how should it be described?
 *
 * Sellability is exactly "may one more unit be reserved", so this is `evaluateVariantCapacity()` at
 * quantity 1 rather than a second rule that happens to agree. Before I4 the storefront decided it
 * independently with `sellableStock <= 0`, which silently assumed `STANDARD` for every product: an
 * `OVERSELL` variant at −3 would have been hidden even though the owner had allowed selling to −20.
 *
 * **This is advisory.** ADR 0014 §2 puts the authoritative check at the order commit boundary, where
 * I6a recomputes it inside the transaction holding the variant lock. A page rendered a moment ago
 * cannot bind a decision made now, so a surface may show a variant that checkout then refuses —
 * that ordering is intended, and the reverse (trusting the page) is the oversell §31 forbids.
 */
export function resolveVariantSellability(input: VariantCapacityInput): VariantSellability {
  const decision = evaluateVariantCapacity(input, 1);

  return Object.freeze({
    sellable: decision.allowed,
    reason: decision.reason,
    // The same rule the reservation writes into history, asked at the one unit this function is
    // about, rather than a second comparison that happens to agree at quantity 1.
    isPreorderSale: decision.allowed && resolveAcceptedPreorderState(input, 1) === "PREORDER",
    floor: decision.floor,
  });
}

/**
 * Reservation lifecycle.
 *
 * Deliberately parallel to the existing `LocalOrderState` rather than a second vocabulary:
 * `SUBMITTING` corresponds to `POS_SUBMITTING`, `UNKNOWN` to `SYNC_UNKNOWN`, and `COMMITTED` to
 * `CONFIRMED`. The repository already resolves ambiguous Pancake writes through
 * `SYNC_UNKNOWN`/`CREATE_OUTCOME_UNKNOWN` in `pancake-order-submit.ts`; G5 reuses that outcome
 * rather than inventing a competing notion of "maybe written".
 */
export const RESERVATION_STATES = [
  "RESERVED",
  "SUBMITTING",
  "COMMITTED",
  "RELEASED",
  "UNKNOWN",
] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/**
 * Allowed transitions. Terminal states have none, which is what makes double-release and
 * double-commit unrepresentable *in this state machine* rather than merely unlikely.
 *
 * That scope is the whole caveat, and it is worth stating plainly: the database cannot enforce it.
 * A Prisma enum constrains the *value* of a column, and the ADR 0014 §13 CHECK constraints are all
 * intra-row, so nothing in SQL prevents an `UPDATE` from moving a row `COMMITTED -> RESERVED`. The
 * transition rule is only real if every write goes through a guarded update — `UPDATE ... WHERE id
 * = $1 AND state = $2`, asserting exactly one row was affected — with this predicate choosing `$2`.
 * An unguarded `UPDATE ... WHERE id = $1` silently bypasses everything here.
 *
 * `UNKNOWN` is reachable only from `SUBMITTING` (the write may or may not have landed) and leaves
 * only by reconciliation proving one way or the other. There is deliberately no `UNKNOWN -> UNKNOWN`
 * self-loop and no timeout edge: nothing may release an ambiguous hold on a timer.
 */
export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> =
  Object.freeze({
    RESERVED: Object.freeze(["SUBMITTING", "RELEASED"] as const),
    SUBMITTING: Object.freeze(["COMMITTED", "RELEASED", "UNKNOWN"] as const),
    UNKNOWN: Object.freeze(["COMMITTED", "RELEASED"] as const),
    COMMITTED: Object.freeze([] as const),
    RELEASED: Object.freeze([] as const),
  });

export function canTransition(from: ReservationState, to: ReservationState): boolean {
  return RESERVATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Terminal states accept no further transition, so an at-most-once effect is structural. */
export function isTerminalReservationState(state: ReservationState): boolean {
  return RESERVATION_TRANSITIONS[state].length === 0;
}

export type ReservationHoldInput = Readonly<{
  state: ReservationState;
  /** When the reservation reached `COMMITTED`. Required only for that state. */
  committedAt?: Date | null;
  /**
   * When the mirror's stock observation for this variant **was initiated** — the instant before the
   * Pancake read began, not the instant its result was written locally.
   *
   * The distinction is the whole correctness of the `COMMITTED` rule, so the field is named for the
   * requirement rather than for whichever column happens to supply it. A persist-time marker is
   * **not** a valid value here; see `reservationHoldsCapacity`.
   */
  stockObservationStartedAt?: Date | null;
}>;

/**
 * Whether a reservation still counts against capacity.
 *
 * `RESERVED`, `SUBMITTING` and `UNKNOWN` always hold. `RELEASED` never does.
 *
 * `COMMITTED` is the subtle one, and getting it wrong is a double-count in one direction or an
 * oversell in the other. Once Pancake confirms the order, Pancake will decrement its own stock, and
 * that decrement reaches us through the mirror. Until the mirror observably includes it, the
 * reservation must keep holding — otherwise the units are counted by neither side and a concurrent
 * checkout can spend them twice. Once the mirror has caught up, continuing to hold would subtract
 * them twice.
 *
 * **The retirement test needs evidence about when the observation started, not when it landed.**
 * An earlier version compared a persist-time `WarehouseStock.syncedAt` against `committedAt` and
 * justified it as "a sync strictly newer than the commit necessarily read Pancake after the order
 * landed". That does not follow, and this interleaving breaks it:
 *
 * 1. catalog sync begins a Pancake stock read;
 * 2. the checkout commits on Pancake, which decrements;
 * 3. the in-flight read returns a **pre-commit** snapshot;
 * 4. that snapshot is persisted locally, stamping a marker later than `committedAt`.
 *
 * The mirror now carries stock that does not include the decrement while claiming to be newer than
 * the commit, so a persist-time test retires the hold early and the units are counted by neither
 * side — the exact oversell this ledger exists to prevent.
 *
 * A read that *starts* after the commit cannot miss it, so the sound test is
 * `stockObservationStartedAt > committedAt`. Callers must supply a marker captured before the
 * Pancake request; ADR 0014 §4.1 makes that a binding precondition on the mirror rather than an
 * assumption about a column name.
 *
 * Ties and missing timestamps resolve to *keep holding*, because the failure modes are not
 * symmetric — over-holding refuses a sale that could have been made, while under-holding breaches
 * the hard limit the owner set.
 */
export function reservationHoldsCapacity(input: ReservationHoldInput): boolean {
  switch (input.state) {
    case "RESERVED":
    case "SUBMITTING":
    case "UNKNOWN":
      return true;
    case "RELEASED":
      return false;
    case "COMMITTED": {
      const committedAt = input.committedAt;
      const observedFrom = input.stockObservationStartedAt;
      if (!(committedAt instanceof Date) || !(observedFrom instanceof Date)) return true;
      if (Number.isNaN(committedAt.getTime()) || Number.isNaN(observedFrom.getTime())) return true;
      return !(observedFrom.getTime() > committedAt.getTime());
    }
  }
}

export type MultiLineReservationLine<T> = Readonly<{
  line: T;
  input: VariantCapacityInput;
  quantity: number;
}>;

export type MultiLineReservationDecision<T> = Readonly<{
  allowed: boolean;
  /** Every line's decision, in input order, so an operator sees which one failed and why. */
  decisions: readonly Readonly<{ line: T; decision: CapacityDecision }>[];
  /** The first refused line, or `null` when every line fits. */
  refusedLine: T | null;
}>;

/**
 * All-or-nothing capacity for a multi-line order.
 *
 * Every line is evaluated, not just up to the first failure, so one call explains the whole order
 * rather than making an operator retry to discover the next problem. The order still fails as a
 * unit: a partially reservable basket is a refusal, never a partial reservation (master spec §31).
 *
 * Callers must pass one entry per *variant*; two lines for the same variant would each see the other
 * excluded from `activeReservedQuantity` and could jointly overshoot. I6a merges duplicate variants
 * before calling, and ADR 0014 §7 makes that a precondition of the transaction.
 */
export function evaluateMultiLineReservation<T>(
  lines: readonly MultiLineReservationLine<T>[],
): MultiLineReservationDecision<T> {
  const decisions = lines.map((entry) =>
    Object.freeze({ line: entry.line, decision: evaluateVariantCapacity(entry.input, entry.quantity) }),
  );
  const refused = decisions.find((entry) => !entry.decision.allowed);

  return Object.freeze({
    allowed: lines.length > 0 && refused === undefined,
    decisions: Object.freeze(decisions),
    refusedLine: refused ? refused.line : null,
  });
}
