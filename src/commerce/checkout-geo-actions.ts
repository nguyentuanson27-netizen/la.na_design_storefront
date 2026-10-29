"use server";

import { headers } from "next/headers";

import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig } from "../integrations/pancake/config.ts";
import { deriveGuestCheckoutClientKey } from "./guest-checkout-client-identity.ts";
import { createCheckoutGeoCache } from "./checkout-geo-cache.ts";
import { createGuestCheckoutRateLimiter } from "./guest-checkout-rate-limit.ts";
import {
  createCheckoutGeoPublicActions,
  type CheckoutGeoPublicResult,
} from "./checkout-geo-public-actions.ts";
import {
  loadCheckoutCommunes,
  loadCheckoutProvinces,
  type CheckoutCommune,
  type CheckoutProvince,
} from "./checkout-geo.ts";

const geoRateLimiter = createGuestCheckoutRateLimiter(prisma);

function createServerClient(): PancakeClient {
  const { apiKey } = readPancakeConfig();
  return new PancakeClient({ apiKey });
}

async function allowGeoRead(): Promise<boolean> {
  const requestHeaders = await headers();
  const authConfig = readAuthServerConfig();
  const clientKey = deriveGuestCheckoutClientKey(requestHeaders, authConfig);
  return geoRateLimiter.consumeGeoClient({ clientKey });
}

// Cache only the public picker reads. allowGeoRead is still called on every action, including hits.
// The authoritative submit path continues to validate geo directly against Pancake.
const geoCache = createCheckoutGeoCache({
  loadProvinces: () => loadCheckoutProvinces(createServerClient()),
  loadCommunes: (provinceId) => loadCheckoutCommunes(createServerClient(), provinceId),
});

const publicActions = createCheckoutGeoPublicActions({
  allowRead: allowGeoRead,
  loadProvinces: geoCache.provinces,
  loadCommunes: geoCache.communes,
});

export async function loadCheckoutProvincesAction(): Promise<
  CheckoutGeoPublicResult<CheckoutProvince>
> {
  return publicActions.provinces();
}

export async function loadCheckoutCommunesAction(
  provinceId: unknown,
): Promise<CheckoutGeoPublicResult<CheckoutCommune>> {
  return publicActions.communes(provinceId);
}
