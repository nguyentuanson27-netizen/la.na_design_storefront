import { readAuthServerConfig } from "../auth/config.ts";
import { readGuestShippingPolicy } from "../commerce/guest-shipping-policy.ts";
import { resolveMerchantMarketFromEnvironment } from "../commerce/merchant-offer-mapper.ts";
import { LEGACY_TEMPORARY_STOREFRONT_HOST } from "../commerce/storefront-origin.ts";
import { readProjectConfig } from "../config/project-config.ts";
import { readPancakeConfig } from "../integrations/pancake/config.ts";
import { validateSearchExposureForRelease } from "../seo/search-exposure.ts";
import { readTrackingConfig, resolveTrackingRuntime, type TrackingMode } from "../tracking/config.ts";
import { assertIdentityMirrors, type IdentityMirrorSummary } from "./identity-mirrors.ts";

type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

export type ReleaseReadinessSummary = Readonly<{
  databaseConfigured: true;
  storefrontOriginConfigured: true;
  searchIndexingEnabled: boolean;
  trackingMode: TrackingMode;
  trackingLoadsGoogleTagManager: boolean;
  merchantMarketStatus: "APPROVED" | "UNRESOLVED";
  authConfigured: true;
  trustedIpHeaderConfigured: boolean;
  pancakeConfigured: true;
  pancakeShopId: number;
  shippingPolicy: Readonly<{
    feeVnd: number;
    freeShippingSubtotalVnd: number;
    freeShippingMinQuantity: number;
  }>;
  identityMirrors: IdentityMirrorSummary;
}>;

function validateDatabaseUrl(value: string | undefined): void {
  if (!value) {
    throw new Error("DATABASE_URL must be configured on the server");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
}

export function validateReleaseEnvironment(
  env: ReleaseEnvironment = process.env,
): ReleaseReadinessSummary {
  validateDatabaseUrl(env.DATABASE_URL);
  const searchExposure = validateSearchExposureForRelease(env);
  // A malformed desired mode or container id must stop a deployment here rather than at the first
  // request. The reported posture is deliberately mode-only: the container id is configuration, not
  // a secret, but the summary is printed and has no reason to carry vendor identifiers.
  const tracking = resolveTrackingRuntime(readTrackingConfig(env));
  const merchantMarket = resolveMerchantMarketFromEnvironment(env);
  const auth = readAuthServerConfig(env);
  if (auth.baseURL !== searchExposure.origin) {
    throw new Error("BETTER_AUTH_URL must match APP_DOMAIN storefront origin");
  }
  const pancake = readPancakeConfig(env);
  const shippingPolicy = readGuestShippingPolicy(env);
  // Last, so every existing preflight failure still reports its own reason first. This is the gate
  // that stops a release pointed at another project's database or domain before deploy.sh reaches
  // the backup and migrate steps.
  const identityMirrors = assertIdentityMirrors({
    config: readProjectConfig(),
    databaseUrl: env.DATABASE_URL,
    appDomain: env.APP_DOMAIN,
    composeProject: env.COMPOSE_PROJECT_NAME,
    approvedLegacyDomains: [LEGACY_TEMPORARY_STOREFRONT_HOST],
  });

  return {
    databaseConfigured: true,
    storefrontOriginConfigured: true,
    searchIndexingEnabled: searchExposure.indexingEnabled,
    trackingMode: tracking.mode,
    trackingLoadsGoogleTagManager: tracking.loadsGoogleTagManager,
    merchantMarketStatus: merchantMarket.status,
    authConfigured: true,
    trustedIpHeaderConfigured: auth.ipAddressHeader !== undefined,
    pancakeConfigured: true,
    pancakeShopId: pancake.shopId,
    shippingPolicy,
    identityMirrors,
  };
}
