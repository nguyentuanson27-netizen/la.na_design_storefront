import { readAuthServerConfig } from "../auth/config.ts";
import { auth } from "../auth/server.ts";
import { prisma } from "../db/prisma.ts";
import { createGoogleFlowTryOnClient } from "../integrations/google-flow-try-on/client.ts";\nimport { readTryOnRuntimeConfig } from "../integrations/try-on/config.ts";
import { createVertexTryOnClient } from "../integrations/vertex-try-on/client.ts";
import { getGoogleAccessToken } from "../integrations/vertex-try-on/google-auth.ts";
import { fetchTrustedProductImage } from "../integrations/vertex-try-on/product-image.ts";
import { emitTryOnSignal } from "../operations/try-on-observability.ts";
import { deriveGuestCheckoutClientKey } from "./guest-checkout-client-identity.ts";
import { createMerchandisingRepository } from "./merchandising-repository.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import { getConfiguredStorefrontProductBySlug } from "./storefront-catalog-runtime.ts";
import { resolveTryOnEligibility } from "./try-on-eligibility.ts";
import { createTryOnRateLimiter, type TryOnIdentity } from "./try-on-rate-limit.ts";
import { createTryOnService } from "./try-on-service.ts";

/**
 * The production wiring of virtual try-on: the real catalog, limiter and selected provider.
 * Everything with logic lives in the modules this composes; this file only connects them.
 */

// One limiter per process. Production is a single app container (see `try-on-rate-limit.ts`).
const limiter = createTryOnRateLimiter();

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

/** Same trusted-proxy-header identity the checkout limiters use; `null` when none can be derived. */
function resolveTryOnClientKey(headers: Headers): string | null {
  try {
    return deriveGuestCheckoutClientKey(headers, readAuthServerConfig());
  } catch {
    return null;
  }
}

/** Account ids are short opaque strings; anything else is not trusted as a rate-limit key. */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A signed-in shopper is a member with their own, larger quota; everyone else is a guest keyed by
 * client address. Any account counts — the quota is about cost, not about who the account is.
 *
 * A session lookup that fails (database down, malformed cookie) falls back to guest, never to
 * member, so a fault can only make the limit stricter. With neither a session nor a derivable
 * client address there is no identity to meter, and the request fails closed.
 */
export async function resolveTryOnIdentity(headers: Headers): Promise<TryOnIdentity | null> {
  try {
    const session = await auth.api.getSession({ headers });
    const id = session?.user?.id;
    if (typeof id === "string" && MEMBER_ID_PATTERN.test(id)) return { kind: "member", key: id };
  } catch {
    // Fall through to guest.
  }
  const clientKey = resolveTryOnClientKey(headers);
  return clientKey === null ? null : { kind: "guest", key: clientKey };
}

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
): Promise<Readonly<{ productSlug: string }> | null> {
  if (!readTryOnRuntimeConfig().available) return null;
  try {
    const categoryKeys = await createMerchandisingRepository(prisma).readCategoryMembership(product.id);
    const eligibility = resolveTryOnEligibility({ categoryKeys, media: product.media });
    return eligibility.eligible ? { productSlug: product.slug } : null;
  } catch {
    return null;
  }
}
