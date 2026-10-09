import { readAuthServerConfig } from "../auth/config.ts";
import { auth } from "../auth/server.ts";
import { prisma } from "../db/prisma.ts";
import { createGoogleFlowTryOnClient } from "../integrations/google-flow-try-on/client.ts";
import { warmFlowWorker } from "../integrations/google-flow-try-on/warm.ts";
import { readTryOnRuntimeConfig } from "../integrations/try-on/config.ts";
import { createVertexTryOnClient } from "../integrations/vertex-try-on/client.ts";
import { getGoogleAccessToken } from "../integrations/vertex-try-on/google-auth.ts";
import { fetchTrustedProductImage } from "../integrations/vertex-try-on/product-image.ts";
import { emitTryOnSignal } from "../operations/try-on-observability.ts";
import { deriveGuestCheckoutClientKey } from "./guest-checkout-client-identity.ts";
import { createMerchandisingRepository } from "./merchandising-repository.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import { getConfiguredStorefrontProductBySlug } from "./storefront-catalog-runtime.ts";
import { resolveTryOnEligibility } from "./try-on-eligibility.ts";
import { createTryOnIdentityResolvers } from "./try-on-identity.ts";
import { createTryOnRateLimiter, type TryOnIdentity } from "./try-on-rate-limit.ts";
import { createTryOnService } from "./try-on-service.ts";

/**
 * The production wiring of virtual try-on: the real catalog, limiter and selected provider.
 * Everything with logic lives in the modules this composes; this file only connects them.
 */

// One limiter per process. Production is a single app container (see `try-on-rate-limit.ts`).
// A Flow profile can drive only one Chrome generation at a time. Reserve that constraint in the
// storefront too, so concurrent shoppers fail BUSY before product-image fetch/base64 work reaches
// the worker. Vertex keeps the existing concurrency of three.
const startupTryOnConfig = readTryOnRuntimeConfig();
const limiter = createTryOnRateLimiter(
  startupTryOnConfig.available && startupTryOnConfig.provider === "flow" ? { maxConcurrent: 1 } : {},
);

async function loadProduct(slug: string) {
  let product: Awaited<ReturnType<typeof getConfiguredStorefrontProductBySlug>>;
  try {
    product = await getConfiguredStorefrontProductBySlug(slug);
  } catch (error) {
    // A malformed slug is a bad request, not a server fault.
    if (error instanceof RangeError) return null;
    throw error;
  }
  if (!product) return null;
  const categoryKeys = await createMerchandisingRepository(prisma).readCategoryMembership(product.id);
  return { slug: product.slug, categoryKeys, media: product.media };
}

/** Today's remaining attempts for an identity, from the same limiter the service spends. */
export const peekTryOnQuota = (identity: TryOnIdentity) => limiter.peekQuota(identity);

export const tryOnService = createTryOnService({
  readConfig: () => readTryOnRuntimeConfig(),
  limiter,
  loadProduct,
  fetchProductImage: (url) => fetchTrustedProductImage(url),
  generate: ({ config, person, product }) =>
    config.provider === "flow"
      ? createGoogleFlowTryOnClient({ config }).generate({ person, product })
      : createVertexTryOnClient({ config, getAccessToken: getGoogleAccessToken }).generate({ person, product }),
  emit: (signal) => emitTryOnSignal(signal),
});

/**
 * Gets the provider ready for a shopper who is about to try something on. Only the Flow worker has
 * anything to prepare (its Chrome); Vertex needs nothing. Fire and forget.
 */
export function warmTryOnProvider(): void {
  const config = readTryOnRuntimeConfig();
  if (config.available && config.provider === "flow") warmFlowWorker({ config });
}

/** Same trusted-proxy-header identity the checkout limiters use; `null` when none can be derived. */
function resolveTryOnClientKey(headers: Headers): string | null {
  try {
    return deriveGuestCheckoutClientKey(headers, readAuthServerConfig());
  } catch {
    return null;
  }
}

const identityResolvers = createTryOnIdentityResolvers({
  getSessionUserId: async (headers) => (await auth.api.getSession({ headers }))?.user?.id,
  deriveClientKey: resolveTryOnClientKey,
});

/**
 * Who is spending an attempt: a signed-in shopper is a member with their own, larger quota; everyone
 * else is a guest keyed by client address. A failed session lookup counts as a guest, which can only
 * make the limit stricter. With neither a session nor a derivable client address there is no identity
 * to meter, and the request fails closed. See `try-on-identity.ts`.
 */
export const resolveTryOnIdentity = identityResolvers.forAttempt;

/**
 * Who is *asking what they have left*: the same answer, except that a failed session lookup is an
 * error (the quota endpoint reports it as unavailable) instead of a guess that a member is a guest.
 */
export const resolveTryOnDisplayIdentity = identityResolvers.forDisplay;

/**
 * Whether the PDP should offer try-on for this product, decided on the server so the browser never
 * learns a rule it could second-guess.
 *
 * Never throws and never blocks the page: any failure reading membership simply hides the entry
 * point. With the kill switch off it returns before touching the database, so the disabled path
 * adds no work to the PDP.
 */
export async function resolveProductTryOn(
  product: Readonly<{ id: string; slug: string; media: StorefrontProductMedia }>,
): Promise<Readonly<{ productSlug: string; provider: "vertex" | "flow" }> | null> {
  const config = readTryOnRuntimeConfig();
  if (!config.available) return null;
  try {
    const categoryKeys = await createMerchandisingRepository(prisma).readCategoryMembership(product.id);
    const eligibility = resolveTryOnEligibility({ categoryKeys, media: product.media });
    return eligibility.eligible ? { productSlug: product.slug, provider: config.provider } : null;
  } catch {
    return null;
  }
}
