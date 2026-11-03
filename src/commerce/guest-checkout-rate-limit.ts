import { createHmac } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.ts";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CLIENT_ATTEMPTS = 20;
const DEFAULT_CLIENT_WINDOW_MS = 60_000;
// Slower-moving ceilings against order flooding. The per-minute buckets stop a burst; these stop
// the same abuse spread out, which a per-minute limit alone lets through indefinitely.
//  - Per client, per hour. Phones on one mobile carrier can share an address, so this is a ceiling
//    far above what a household or a shared connection places, not a tight quota.
//  - Per phone number, per day, counting orders that were actually placed: the case this exists for
//    is one number receiving an unwanted COD parcel again and again, and one person rarely places
//    more than a few real orders in a day.
const DEFAULT_MAX_CLIENT_HOURLY_ATTEMPTS = 60;
const DEFAULT_CLIENT_HOURLY_WINDOW_MS = 60 * 60_000;
const DEFAULT_MAX_PHONE_DAILY_ORDERS = 5;
const DEFAULT_PHONE_DAILY_WINDOW_MS = 24 * 60 * 60_000;
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
  maxClientHourlyAttempts?: number;
  clientHourlyWindowMs?: number;
  maxPhoneDailyOrders?: number;
  phoneDailyWindowMs?: number;
  /**
   * Server-only secret the phone buckets are keyed with. Defaults to `BETTER_AUTH_SECRET`, which the
   * app already refuses to start without. Never stored in the database.
   */
  phoneKeySecret?: string;
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
  const maxClientHourlyAttempts = requirePositiveSafeInteger(
    options.maxClientHourlyAttempts ?? DEFAULT_MAX_CLIENT_HOURLY_ATTEMPTS,
    "Checkout client hourly max attempts",
  );
  const clientHourlyWindowMs = requirePositiveSafeInteger(
    options.clientHourlyWindowMs ?? DEFAULT_CLIENT_HOURLY_WINDOW_MS,
    "Checkout client hourly window",
  );
  const maxPhoneDailyOrders = requirePositiveSafeInteger(
    options.maxPhoneDailyOrders ?? DEFAULT_MAX_PHONE_DAILY_ORDERS,
    "Checkout phone daily max orders",
  );
  const phoneDailyWindowMs = requirePositiveSafeInteger(
    options.phoneDailyWindowMs ?? DEFAULT_PHONE_DAILY_WINDOW_MS,
    "Checkout phone daily window",
  );
  const clientHourlyCappedCount = cappedCount(maxClientHourlyAttempts, "Checkout client hourly max attempts");
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

  /** The same client, over an hour. Consumed with the per-minute bucket on every submit attempt. */
  async function consumeClientHourly({
    clientKey,
    now = new Date(),
  }: {
    clientKey: string;
    now?: Date;
  }): Promise<boolean> {
    return consumeBucket({
      bucketKey: `checkout-client-hour:${requireClientKey(clientKey)}`,
      now,
      windowMs: clientHourlyWindowMs,
      maxAttempts: maxClientHourlyAttempts,
      cap: clientHourlyCappedCount,
    });
  }

  const MIN_PHONE_KEY_SECRET_LENGTH = 32;
  let phoneKey: Buffer | null = null;

  /**
   * HMAC-SHA-256 of the normalized number under a server-only key, so a copy of the `rateLimit`
   * table cannot be matched against hashes of candidate numbers: the space of Vietnamese numbers is
   * small enough that an unkeyed hash would only pseudonymize them. The key is derived per purpose
   * (`...:v2`), so the app secret is never used directly and a future scheme is a new version.
   * Changing the secret only starts the counters afresh.
   */
  function phoneDigest(phone: string): string {
    if (typeof phone !== "string" || !/^0\d{9,10}$/.test(phone)) {
      throw new TypeError("Checkout phone key must be a normalized Vietnamese phone number");
    }
    if (phoneKey === null) {
      const secret = options.phoneKeySecret ?? process.env.BETTER_AUTH_SECRET ?? "";
      if (secret.trim().length < MIN_PHONE_KEY_SECRET_LENGTH) {
        throw new TypeError("Checkout phone limiter needs a server secret of at least 32 characters");
      }
      phoneKey = createHmac("sha256", secret).update("la-na:checkout-phone-limit:v2").digest();
    }
    return createHmac("sha256", phoneKey).update(phone).digest("hex");
  }

  const phoneCounterKey = (phone: string) => `checkout-phone-day:v2:${phoneDigest(phone)}`;
  // One claim per (phone, cart): a retry of the same order finds its claim and is not counted twice.
  const phoneClaimKey = (phone: string, cartId: string) =>
    `checkout-phone-claim:v2:${phoneDigest(phone)}:${requireCartId(cartId)}`;

  type PhoneAdmission = "ADMITTED" | "ALREADY_ADMITTED" | "REFUSED";

  /**
   * Reserves one of this number's daily orders for this cart, atomically, before the order is
   * created anywhere else. Two carts racing at the ceiling cannot both pass: the counter row is the
   * single point they serialize on, and it only advances while it is under the ceiling.
   *
   * - `ADMITTED`: a new reservation was taken; the caller must `releasePhoneOrder` if the order then
   *   fails for certain, and leaves it in place otherwise (confirmed, or an order may exist).
   * - `ALREADY_ADMITTED`: this cart already holds one (a retry of the same order); nothing is spent.
   * - `REFUSED`: the number has used its orders for the day; nothing was reserved.
   */
  async function admitPhoneOrder({
    phone,
    cartId,
    now = new Date(),
  }: {
    phone: string;
    cartId: string;
    now?: Date;
  }): Promise<PhoneAdmission> {
    const counterKey = phoneCounterKey(phone);
    const claimKey = phoneClaimKey(phone, cartId);
    const nowMs = BigInt(requireNow(now).getTime());
    const resetBefore = nowMs - BigInt(phoneDailyWindowMs);

    const admission = await client.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "rateLimit" AS c ("id", "key", "count", "lastRequest")
        VALUES (${claimKey}, ${claimKey}, 1, ${nowMs})
        ON CONFLICT ("id") DO UPDATE SET "count" = 1, "lastRequest" = ${nowMs}
        WHERE c."lastRequest" <= ${resetBefore}
        RETURNING "id"
      `;
      if (claimed.length === 0) return "ALREADY_ADMITTED" as const;

      const counted = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "rateLimit" AS existing ("id", "key", "count", "lastRequest")
        VALUES (${counterKey}, ${counterKey}, 1, ${nowMs})
        ON CONFLICT ("id") DO UPDATE SET
          "count" = CASE WHEN existing."lastRequest" <= ${resetBefore} THEN 1 ELSE existing."count" + 1 END,
          "lastRequest" = CASE WHEN existing."lastRequest" <= ${resetBefore} THEN ${nowMs} ELSE existing."lastRequest" END
        WHERE existing."lastRequest" <= ${resetBefore} OR existing."count" < ${maxPhoneDailyOrders}
        RETURNING "count"
      `;
      if (counted.length === 0) {
        // At the ceiling: give back the claim taken above, in the same transaction.
        await tx.$executeRaw`DELETE FROM "rateLimit" WHERE "id" = ${claimKey}`;
        return "REFUSED" as const;
      }
      return "ADMITTED" as const;
    });

    if (admission === "ADMITTED") await sweepExpiredPhoneRows(nowMs).catch(() => undefined);
    return admission;
  }

  /**
   * Gives back a reservation `admitPhoneOrder` took for this cart, when the order is known not to
   * exist. Does nothing for a cart that holds none, so calling it twice never frees a second slot.
   */
  async function releasePhoneOrder({
    phone,
    cartId,
    now = new Date(),
  }: {
    phone: string;
    cartId: string;
    now?: Date;
  }): Promise<void> {
    const counterKey = phoneCounterKey(phone);
    const claimKey = phoneClaimKey(phone, cartId);
    const resetBefore = BigInt(requireNow(now).getTime()) - BigInt(phoneDailyWindowMs);

    await client.$transaction(async (tx) => {
      const deleted = await tx.$queryRaw<Array<{ id: string }>>`
        DELETE FROM "rateLimit" WHERE "id" = ${claimKey} AND "lastRequest" > ${resetBefore} RETURNING "id"
      `;
      if (deleted.length === 0) return;
      await tx.$executeRaw`
        UPDATE "rateLimit" SET "count" = GREATEST("count" - 1, 0)
        WHERE "id" = ${counterKey} AND "lastRequest" > ${resetBefore}
      `;
    });
  }

  // Expired counters and claims hold nothing useful and are pseudonymous personal data, so each
  // admission removes a bounded batch of them; the same pattern as the other pseudonymous limiters.
  async function sweepExpiredPhoneRows(nowMs: bigint): Promise<void> {
    const staleBefore = nowMs - BigInt(phoneDailyWindowMs);
    await client.$executeRaw`
      WITH stale AS (
        SELECT "id" FROM "rateLimit"
        WHERE ("id" LIKE 'checkout-phone-day:%' OR "id" LIKE 'checkout-phone-claim:%')
          AND "lastRequest" <= ${staleBefore}
        ORDER BY "lastRequest", "id" LIMIT 50 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "rateLimit" AS target USING stale WHERE target."id" = stale."id"
    `;
  }

  return { consume, consumeClient, consumeClientHourly, admitPhoneOrder, releasePhoneOrder, consumeGeoClient, consumeUpsellClient, consumeUpsellBrowseClient, consumeUpsellPageClient };
}
