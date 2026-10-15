import { readAuthServerConfig } from "../auth/config.ts";
import { saveMetaPurchaseContextSafely, type MetaPurchaseRequestContext } from "./meta-purchase-reporting.ts";
import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig, type PancakeConfig } from "../integrations/pancake/config.ts";
import { loadCheckoutCommunes, loadCheckoutProvinces } from "./checkout-geo.ts";
import { createCapacityReservationRepository } from "./capacity-reservation.ts";
import { validateCheckoutGeoSelection } from "./checkout-geo-validation.ts";
import {
  issueNonclaimAcknowledgement,
  verifyBenefitQuoteProof,
  verifyNonclaimAcknowledgement,
  verifyRenderedQuoteProof,
  type RenderedQuoteProofFacts,
  type RenderedQuoteProofRejection,
} from "./checkout-quote-proof.ts";
import { recoverStrandedGuestCheckoutForCart } from "./guest-checkout-recovery.ts";
import { generateOrderPublicCode } from "./order-public-code.ts";
import {
  createGuestCheckoutSnapshotService,
  requiresFreshGuestCheckoutSnapshot,
  type BenefitQuoteAuthority,
} from "./guest-checkout-snapshot.ts";
import {
  createGuestCheckoutSubmitService,
  type GuestCheckoutSubmitDependencies,
} from "./guest-checkout-submit.ts";
import {
  describeBenefitCheckoutOutcome,
  describeBenefitQuoteSummary,
  describeRenderedQuoteProofRejection,
  emitPromotionSignal,
} from "../operations/promotion-observability.ts";
import { createPancakeOrderSubmissionRuntime } from "./pancake-order-submit-runtime.ts";
import { createPancakeOrderReconciliationRuntime } from "./pancake-order-reconciliation-runtime.ts";

type SnapshotAuthority = Readonly<{
  checkoutInputValidated: boolean;
  verifyRenderedQuote: (
    facts: RenderedQuoteProofFacts,
  ) => ReturnType<typeof verifyRenderedQuoteProof>;
  /** GQ17 -- how a cart with gifts or tier segments is proven; the same cart-bound secret. */
  benefits: BenefitQuoteAuthority;
}>;

type GuestCheckoutSubmitRuntimeDependencies = Readonly<{
  readConfig: () => PancakeConfig;
  requiresFreshSnapshot: (cartId: string) => Promise<boolean>;
  validateGeo: (
    config: PancakeConfig,
    checkoutInput: unknown,
  ) => ReturnType<typeof validateCheckoutGeoSelection>;
  createSnapshot: (
    authority: SnapshotAuthority,
  ) => GuestCheckoutSubmitDependencies["snapshot"];
  createOrderSubmission: (
    config: PancakeConfig,
  ) => GuestCheckoutSubmitDependencies["orderSubmission"];
  createOrderReconciliation: (
    config: PancakeConfig,
  ) => Pick<ReturnType<typeof createPancakeOrderReconciliationRuntime>, "reconcileCart">;
  recoverStranded: (input: { cartId: string; now: Date }) => Promise<void>;
  generatePublicCode: () => string;
  onQuoteProofRejection: (reason: RenderedQuoteProofRejection) => void;
  /** GQ24: benefit checkout outcome and quote-summary observers; default to the NDJSON signal stream. */
  onBenefitOutcome: NonNullable<GuestCheckoutSubmitDependencies["onBenefitOutcome"]>;
  onBenefitQuote: NonNullable<BenefitQuoteAuthority["onBenefitQuote"]>;
  /**
   * The server-only key material for the rendered-quote proof. Injected as a reader rather than
   * read at module load so a test can supply its own secret without touching process env, and so a
   * misconfigured secret fails at submit time rather than at import time.
   */
  readQuoteProofSecret: () => string;
  clock: () => Date;
  /**
   * I6b — the ADR 0014 §6.2 capacity boundary. Injectable like every other dependency here, so a
   * test can drive the reservation state machine without a database, and so the default stays the
   * real repository rather than something a test could quietly leave unwired.
   */
  createCapacity: () => NonNullable<GuestCheckoutSubmitDependencies["capacity"]>;
}>;

type GuestCheckoutSubmitRuntimeOptions = Partial<GuestCheckoutSubmitRuntimeDependencies>;

async function validateCheckoutGeoWithPancake(
  config: PancakeConfig,
  checkoutInput: unknown,
) {
  const client = new PancakeClient({ apiKey: config.apiKey });
  return validateCheckoutGeoSelection(
    {
      loadProvinces: () => loadCheckoutProvinces(client),
      loadCommunes: (provinceId) => loadCheckoutCommunes(client, provinceId),
    },
    checkoutInput,
  );
}

export function createGuestCheckoutSubmitRuntime(
  options: GuestCheckoutSubmitRuntimeOptions = {},
) {
  const readConfig = options.readConfig ?? readPancakeConfig;
  const requiresFreshSnapshot =
    options.requiresFreshSnapshot ??
    ((cartId) => requiresFreshGuestCheckoutSnapshot(prisma, cartId));
  const validateGeo = options.validateGeo ?? validateCheckoutGeoWithPancake;
  const createSnapshot =
    options.createSnapshot ??
    ((authority) => createGuestCheckoutSnapshotService(prisma, authority));
  const createOrderSubmission =
    options.createOrderSubmission ?? createPancakeOrderSubmissionRuntime;
  const createOrderReconciliation =
    options.createOrderReconciliation ?? createPancakeOrderReconciliationRuntime;
  const recoverStranded =
    options.recoverStranded ??
    (({ cartId, now }) => recoverStrandedGuestCheckoutForCart(prisma, cartId, now));
  const generatePublicCode = options.generatePublicCode ?? generateOrderPublicCode;
  const readQuoteProofSecret =
    options.readQuoteProofSecret ?? (() => readAuthServerConfig().secret);
  const clock = options.clock ?? (() => new Date());
  const createCapacity =
    options.createCapacity ?? (() => createCapacityReservationRepository(prisma));
  const onQuoteProofRejection =
    options.onQuoteProofRejection ??
    ((reason) => {
      emitPromotionSignal(describeRenderedQuoteProofRejection({ reason }));
    });

  const onBenefitOutcome =
    options.onBenefitOutcome ??
    ((outcome, proofReason) => {
      emitPromotionSignal(describeBenefitCheckoutOutcome({ outcome, proofReason }));
    });
  const onBenefitQuote =
    options.onBenefitQuote ??
    ((summary) => {
      emitPromotionSignal(describeBenefitQuoteSummary(summary));
    });

  async function submit({
    cartId,
    checkoutInput,
    quoteProof,
    nonclaimAcknowledgement,
    nonclaimAcknowledged = false,
    metaContext,
  }: {
    cartId: string;
    checkoutInput: unknown;
    quoteProof: unknown;
    /** GQ16: the buyer's signed acknowledgement of unclaimed gift slots, when the quote has any. */
    nonclaimAcknowledgement?: unknown;
    /**
     * GQ19: the checkout form's tick. Not evidence on its own -- the snapshot asks for an
     * acknowledgement only after the quote proof has verified against the quote it just recomputed, so
     * minting one here for that quote records "this buyer, having seen exactly this quote, said yes"
     * (`acknowledgedAt` comes from the signed payload). A tick for a quote that moved never gets here:
     * the proof fails first and the buyer is shown the refreshed quote, unticked.
     */
    nonclaimAcknowledged?: boolean;
    metaContext?: MetaPurchaseRequestContext | null;
  }) {
    const now = clock();
    await recoverStranded({ cartId, now });

    const config = readConfig();
    await createOrderReconciliation(config).reconcileCart(cartId);
    const needsFreshSnapshot = await requiresFreshSnapshot(cartId);

    let authoritativeCheckoutInput = checkoutInput;
    let checkoutInputValidated = false;
    if (needsFreshSnapshot) {
      const geoValidation = await validateGeo(config, checkoutInput);
      if (!geoValidation.ok) {
        return {
          ok: false as const,
          status: "RETRYABLE" as const,
          reason: geoValidation.reason,
        };
      }
      authoritativeCheckoutInput = geoValidation.checkoutInput;
      checkoutInputValidated = true;
    }

    // The cart id comes from the HttpOnly cookie the server just read, never from the request
    // body, so binding the proof to it here is what makes a token minted for another cart useless.
    const quoteProofSecret = readQuoteProofSecret();
    const snapshot = createSnapshot({
      checkoutInputValidated,
      verifyRenderedQuote: (currentQuote) =>
        verifyRenderedQuoteProof({
          proof: quoteProof,
          cartId,
          currentQuote,
          secret: quoteProofSecret,
        }),
      benefits: {
        onBenefitQuote,
        verifyBenefitQuote: (currentQuote) =>
          verifyBenefitQuoteProof({
            proof: quoteProof,
            cartId,
            currentQuote,
            secret: quoteProofSecret,
          }),
        verifyNonclaimAcknowledgement: (currentQuote) =>
          verifyNonclaimAcknowledgement({
            token:
              nonclaimAcknowledgement ??
              (nonclaimAcknowledged
                ? issueNonclaimAcknowledgement({ quote: currentQuote, cartId, secret: quoteProofSecret, now })
                : undefined),
            cartId,
            currentQuote,
            secret: quoteProofSecret,
            now,
          }),
      },
    });
    const service = createGuestCheckoutSubmitService({
      snapshot: {
        async create(input) {
          const result = await snapshot.create(input);
          if (result.ok && metaContext) await saveMetaPurchaseContextSafely(prisma, result.order.publicCode, metaContext);
          return result;
        },
      },
      orderSubmission: createOrderSubmission(config),
      generatePublicCode,
      onQuoteProofRejection,
      onBenefitOutcome,
      // I6b — the production path holds capacity. This wiring is what makes the ADR 0014 §6.2 gate
      // real for a buyer: the dependency is optional on the service below so unit tests can describe
      // the pre-I6b path, and defaulting it to the real repository here is what stops that being a
      // bypass in production.
      capacity: createCapacity(),
      clock,
    });

    return service.submit({
      cartId,
      shopId: config.shopId,
      checkoutInput: authoritativeCheckoutInput,
      now,
    });
  }

  return { submit };
}

export async function submitGuestCheckoutByCart(input: {
  cartId: string;
  checkoutInput: unknown;
  quoteProof: unknown;
  nonclaimAcknowledgement?: unknown;
  nonclaimAcknowledged?: boolean;
  metaContext?: MetaPurchaseRequestContext | null;
}) {
  return createGuestCheckoutSubmitRuntime().submit(input);
}
