"use server";

import { headers } from "next/headers";

import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig } from "../integrations/pancake/config.ts";
import { deriveGuestCheckoutClientKey } from "./guest-checkout-client-identity.ts";
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

const publicActions = createCheckoutGeoPublicActions({
  allowRead: allowGeoRead,
  loadProvinces: () => loadCheckoutProvinces(createServerClient()),
  loadCommunes: (provinceId) => loadCheckoutCommunes(createServerClient(), provinceId),
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
