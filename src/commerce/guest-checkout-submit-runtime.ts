import { randomUUID } from "node:crypto";

import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig, type PancakeConfig } from "../integrations/pancake/config.ts";
import {
  loadCheckoutCommunes,
  loadCheckoutDistricts,
  loadCheckoutProvinces,
} from "./checkout-geo.ts";
import { createCapacityReservationRepository } from "./capacity-reservation.ts";
import { validateCheckoutGeoSelection } from "./checkout-geo-validation.ts";
import {
  verifyRenderedQuoteProof,
  type RenderedQuoteProofFacts,
  type RenderedQuoteProofRejection,
} from "./checkout-quote-proof.ts";
import { recoverStrandedGuestCheckoutForCart } from "./guest-checkout-recovery.ts";
import {
  createGuestCheckoutSnapshotService,
  requiresFreshGuestCheckoutSnapshot,
} from "./guest-checkout-snapshot.ts";
import {
  createGuestCheckoutSubmitService,
  type GuestCheckoutSubmitDependencies,
} from "./guest-checkout-submit.ts";
import {
  describeRenderedQuoteProofRejection,
  emitPromotionSignal,
} from "../operations/promotion-observability.ts";
import { createPancakeOrderSubmissionRuntime } from "./pancake-order-submit-runtime.ts";

type SnapshotAuthority = Readonly<{
  checkoutInputValidated: boolean;
  verifyRenderedQuote: (
    facts: RenderedQuoteProofFacts,
  ) => ReturnType<typeof verifyRenderedQuoteProof>;
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
  recoverStranded: (input: { cartId: string; now: Date }) => Promise<void>;
  generatePublicCode: () => string;
  onQuoteProofRejection: (reason: RenderedQuoteProofRejection) => void;
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
      loadDistricts: (provinceId) => loadCheckoutDistricts(client, provinceId),
      loadCommunes: (provinceId, districtId) =>
        loadCheckoutCommunes(client, provinceId, districtId),
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
  const recoverStranded =
    options.recoverStranded ??
    (({ cartId, now }) => recoverStrandedGuestCheckoutForCart(prisma, cartId, now));
  const generatePublicCode = options.generatePublicCode ?? (() => `LA-${randomUUID()}`);
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

  async function submit({
    cartId,
    checkoutInput,
    quoteProof,
  }: {
    cartId: string;
    checkoutInput: unknown;
    quoteProof: unknown;
  }) {
    const now = clock();
    await recoverStranded({ cartId, now });

    const config = readConfig();
    const needsFreshSnapshot = await requiresFreshSnapshot(cartId);

    let authoritativeCheckoutInput = checkoutInput;
    let checkoutInputValidated = false;
    if (needsFreshSnapshot) {
      const geoValidation = await validateGeo(config, checkoutInput);
      if (!geoValidation.ok) {
        return {
          ok: false as const,
          status: "RETRYABLE" as const,
          reason: "INVALID_INPUT" as const,
        };
      }
      authoritativeCheckoutInput = geoValidation.checkoutInput;
      checkoutInputValidated = true;
    }

    // The cart id comes from the HttpOnly cookie the server just read, never from the request
    // body, so binding the proof to it here is what makes a token minted for another cart useless.
    const quoteProofSecret = readQuoteProofSecret();
    const service = createGuestCheckoutSubmitService({
      snapshot: createSnapshot({
        checkoutInputValidated,
        verifyRenderedQuote: (currentQuote) =>
          verifyRenderedQuoteProof({
            proof: quoteProof,
            cartId,
            currentQuote,
            secret: quoteProofSecret,
          }),
      }),
      orderSubmission: createOrderSubmission(config),
      generatePublicCode,
      onQuoteProofRejection,
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
}) {
  return createGuestCheckoutSubmitRuntime().submit(input);
}
