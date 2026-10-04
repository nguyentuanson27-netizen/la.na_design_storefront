import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { readTryOnConfig } from "../integrations/vertex-try-on/config.ts";
import { createVertexTryOnClient } from "../integrations/vertex-try-on/client.ts";
import { getGoogleAccessToken } from "../integrations/vertex-try-on/google-auth.ts";
import { fetchTrustedProductImage } from "../integrations/vertex-try-on/product-image.ts";
import { emitTryOnSignal } from "../operations/try-on-observability.ts";
import { deriveGuestCheckoutClientKey } from "./guest-checkout-client-identity.ts";
import { createMerchandisingRepository } from "./merchandising-repository.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import { getConfiguredStorefrontProductBySlug } from "./storefront-catalog-runtime.ts";
import { resolveTryOnEligibility } from "./try-on-eligibility.ts";
import { createTryOnRateLimiter } from "./try-on-rate-limit.ts";
import { createTryOnService } from "./try-on-service.ts";

/**
 * The production wiring of virtual try-on: the real catalog, the real limiter, the real Vertex
 * client. Everything with logic lives in the modules this composes; this file only connects them.
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
  readConfig: () => readTryOnConfig(),
  limiter,
  loadProduct,
  fetchProductImage: (url) => fetchTrustedProductImage(url),
  generate: ({ config, person, product }) =>
    createVertexTryOnClient({ config, getAccessToken: getGoogleAccessToken }).generate({ person, product }),
  emit: (signal) => emitTryOnSignal(signal),
});

/** Same trusted-proxy-header identity the checkout limiters use; `null` fails the request closed. */
export function resolveTryOnClientKey(headers: Headers): string | null {
  try {
    return deriveGuestCheckoutClientKey(headers, readAuthServerConfig());
  } catch {
    return null;
  }
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
  if (!readTryOnConfig().available) return null;
  try {
    const categoryKeys = await createMerchandisingRepository(prisma).readCategoryMembership(product.id);
    const eligibility = resolveTryOnEligibility({ categoryKeys, media: product.media });
    return eligibility.eligible ? { productSlug: product.slug } : null;
  } catch {
    return null;
  }
}
