import type { PrismaClient } from "../generated/prisma/client.ts";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CLIENT_ATTEMPTS = 20;
const DEFAULT_CLIENT_WINDOW_MS = 60_000;
const DEFAULT_MAX_GEO_CLIENT_ATTEMPTS = 60;
const DEFAULT_GEO_CLIENT_WINDOW_MS = 60_000;
const DEFAULT_MAX_UPSELL_CLIENT_ATTEMPTS = 20;
const DEFAULT_UPSELL_CLIENT_WINDOW_MS = 60_000;
const DEFAULT_MAX_UPSELL_BROWSE_CLIENT_ATTEMPTS = 10;
const DEFAULT_UPSELL_BROWSE_CLIENT_WINDOW_MS = 60_000;
// Pages 2.. of the offer listing: one canonical quote and two SQL statements each, about an eighth of the cost the
// 10/min first-page budget was sized for, and kept off the shared POST budget so paging cannot starve the banner.
const DEFAULT_MAX_UPSELL_PAGE_CLIENT_ATTEMPTS = 30;
const DEFAULT_UPSELL_PAGE_CLIENT_WINDOW_MS = 60_000;
const MAX_CART_ID_LENGTH = 128;
const PSEUDONYMOUS_CLIENT_KEY = /^v1:[0-9a-f]{64}$/;

type GuestCheckoutRateLimiterOptions = Readonly<{
  maxAttempts?: number;
  windowMs?: number;
  maxClientAttempts?: number;
  clientWindowMs?: number;
  maxGeoClientAttempts?: number;
  geoClientWindowMs?: number;
  maxUpsellClientAttempts?: number;
  upsellClientWindowMs?: number;
  maxUpsellBrowseClientAttempts?: number;
  upsellBrowseClientWindowMs?: number;
  maxUpsellPageClientAttempts?: number;
  upsellPageClientWindowMs?: number;
}>;

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireCartId(cartId: string): string {
  if (
    typeof cartId !== "string" ||
    cartId.length === 0 ||
    cartId.length > MAX_CART_ID_LENGTH ||
    cartId.trim() !== cartId
  ) {
    throw new TypeError("Checkout cart id must be a bounded non-empty string");
  }
  return cartId;
}

function requireClientKey(clientKey: string): string {
  if (typeof clientKey !== "string" || !PSEUDONYMOUS_CLIENT_KEY.test(clientKey)) {
    throw new TypeError("Checkout client key must be a pseudonymous v1 key");
  }
  return clientKey;
}

function requireNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("Checkout rate-limit time must be valid");
  }
  return now;
}

function cappedCount(maxAttempts: number, label: string): number {
  const value = maxAttempts + 1;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is too large`);
  }
  return value;
}

export function createGuestCheckoutRateLimiter(
  client: PrismaClient,
  options: GuestCheckoutRateLimiterOptions = {},
) {
  const maxAttempts = requirePositiveSafeInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "Checkout max attempts",
  );
  const windowMs = requirePositiveSafeInteger(
    options.windowMs ?? DEFAULT_WINDOW_MS,
    "Checkout rate-limit window",
  );
  const maxClientAttempts = requirePositiveSafeInteger(
    options.maxClientAttempts ?? DEFAULT_MAX_CLIENT_ATTEMPTS,
    "Checkout client max attempts",
  );
  const clientWindowMs = requirePositiveSafeInteger(
    options.clientWindowMs ?? DEFAULT_CLIENT_WINDOW_MS,
    "Checkout client rate-limit window",
  );
  const maxGeoClientAttempts = requirePositiveSafeInteger(
    options.maxGeoClientAttempts ?? DEFAULT_MAX_GEO_CLIENT_ATTEMPTS,
    "Checkout geo client max attempts",
  );
  const geoClientWindowMs = requirePositiveSafeInteger(
    options.geoClientWindowMs ?? DEFAULT_GEO_CLIENT_WINDOW_MS,
    "Checkout geo client rate-limit window",
  );
  const maxUpsellClientAttempts = requirePositiveSafeInteger(
    options.maxUpsellClientAttempts ?? DEFAULT_MAX_UPSELL_CLIENT_ATTEMPTS,
    "Checkout upsell client max attempts",
  );
  const upsellClientWindowMs = requirePositiveSafeInteger(
    options.upsellClientWindowMs ?? DEFAULT_UPSELL_CLIENT_WINDOW_MS,
    "Checkout upsell client window",
  );
  const maxUpsellBrowseClientAttempts = requirePositiveSafeInteger(
    options.maxUpsellBrowseClientAttempts ?? DEFAULT_MAX_UPSELL_BROWSE_CLIENT_ATTEMPTS,
    "Checkout upsell browse client max attempts",
  );
  const upsellBrowseClientWindowMs = requirePositiveSafeInteger(
    options.upsellBrowseClientWindowMs ?? DEFAULT_UPSELL_BROWSE_CLIENT_WINDOW_MS,
    "Checkout upsell browse client window",
  );
  const maxUpsellPageClientAttempts = requirePositiveSafeInteger(
    options.maxUpsellPageClientAttempts ?? DEFAULT_MAX_UPSELL_PAGE_CLIENT_ATTEMPTS,
    "Checkout upsell page client max attempts",
  );
  const upsellPageClientWindowMs = requirePositiveSafeInteger(
    options.upsellPageClientWindowMs ?? DEFAULT_UPSELL_PAGE_CLIENT_WINDOW_MS,
    "Checkout upsell page client window",
  );
  const upsellPageClientCappedCount = cappedCount(maxUpsellPageClientAttempts, "Checkout upsell page client max attempts");
  const upsellBrowseClientCappedCount = cappedCount(maxUpsellBrowseClientAttempts, "Checkout upsell browse client max attempts");
  const upsellClientCappedCount = cappedCount(maxUpsellClientAttempts, "Checkout upsell client max attempts");
  const cartCappedCount = cappedCount(maxAttempts, "Checkout max attempts");
  const clientCappedCount = cappedCount(maxClientAttempts, "Checkout client max attempts");
  const geoClientCappedCount = cappedCount(
    maxGeoClientAttempts,
    "Checkout geo client max attempts",
  );

  async function consumeBucket({
    bucketKey,
    now,
    windowMs: bucketWindowMs,
    maxAttempts: bucketMaxAttempts,
    cap,
  }: {
    bucketKey: string;
    now: Date;
    windowMs: number;
    maxAttempts: number;
    cap: number;
  }): Promise<boolean> {
    const safeNow = requireNow(now);
    const nowMs = BigInt(safeNow.getTime());
    const resetBefore = nowMs - BigInt(bucketWindowMs);

    const rows = await client.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "rateLimit" AS existing ("id", "key", "count", "lastRequest")
      VALUES (${bucketKey}, ${bucketKey}, 1, ${nowMs})
      ON CONFLICT ("id") DO UPDATE
      SET
        "count" = CASE
          WHEN existing."lastRequest" <= ${resetBefore} THEN 1
          ELSE LEAST(existing."count" + 1, ${cap})
        END,
        "lastRequest" = CASE
          WHEN existing."lastRequest" <= ${resetBefore} THEN ${nowMs}
          ELSE existing."lastRequest"
        END
      RETURNING "count"
    `;

    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count)) {
      throw new Error("Checkout rate-limit storage returned an invalid result");
    }

    return rows[0].count <= bucketMaxAttempts;
  }

  async function consume({
    cartId,
    now = new Date(),
  }: {
    cartId: string;
    now?: Date;
  }): Promise<boolean> {
    const safeCartId = requireCartId(cartId);
    return consumeBucket({
      bucketKey: `checkout:${safeCartId}`,
      now,
      windowMs,
      maxAttempts,
      cap: cartCappedCount,
    });
  }

  async function consumeClient({
    clientKey,
    now = new Date(),
  }: {
    clientKey: string;
    now?: Date;
  }): Promise<boolean> {
    const safeClientKey = requireClientKey(clientKey);
    return consumeBucket({
      bucketKey: `checkout-client:${safeClientKey}`,
      now,
      windowMs: clientWindowMs,
      maxAttempts: maxClientAttempts,
      cap: clientCappedCount,
    });
  }

  async function consumeGeoClient({
    clientKey,
    now = new Date(),
  }: {
    clientKey: string;
    now?: Date;
  }): Promise<boolean> {
    const safeClientKey = requireClientKey(clientKey);
    return consumeBucket({
      bucketKey: `checkout-geo-client:${safeClientKey}`,
      now,
      windowMs: geoClientWindowMs,
      maxAttempts: maxGeoClientAttempts,
      cap: geoClientCappedCount,
    });
  }

  // Upsell is optional and potentially expensive: it must never exhaust geo or submit buckets.
  async function consumeUpsellClient({ clientKey, now = new Date() }: { clientKey: string; now?: Date }): Promise<boolean> {
    return consumeBucket({
      bucketKey: `checkout-upsell-client:${requireClientKey(clientKey)}`,
      now,
      windowMs: upsellClientWindowMs,
      maxAttempts: maxUpsellClientAttempts,
      cap: upsellClientCappedCount,
    });
  }

  // Cheap verification of a potentially forged browse cart UUID is isolated from POST
  // upsell quota; a successful cart-backed GET still consumes the shared POST budget.
  async function consumeUpsellBrowseClient({ clientKey, now = new Date() }: { clientKey: string; now?: Date }): Promise<boolean> {
    return consumeBucket({
      bucketKey: `checkout-upsell-browse-client:${requireClientKey(clientKey)}`,
      now,
      windowMs: upsellBrowseClientWindowMs,
      maxAttempts: maxUpsellBrowseClientAttempts,
      cap: upsellBrowseClientCappedCount,
    });
  }

  /**
   * Page 2 and later of the offer listing. A separate bucket: the first page keeps the browse + shared POST budgets
   * exactly as before, so a shopper paging through a large scope neither trips the first-page limit nor spends the
   * checkout banner's quote budget, while the total quotes one client can cause per minute stays below what the
   * first-page budget alone allowed when each view ran up to eight.
   */
  async function consumeUpsellPageClient({ clientKey, now = new Date() }: { clientKey: string; now?: Date }): Promise<boolean> {
    return consumeBucket({
      bucketKey: `checkout-upsell-page-client:${requireClientKey(clientKey)}`,
      now,
      windowMs: upsellPageClientWindowMs,
      maxAttempts: maxUpsellPageClientAttempts,
      cap: upsellPageClientCappedCount,
    });
  }

  return { consume, consumeClient, consumeGeoClient, consumeUpsellClient, consumeUpsellBrowseClient, consumeUpsellPageClient };
}
