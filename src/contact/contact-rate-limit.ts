import { prisma } from "../db/prisma.ts";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;
const FIFTEEN_MINUTE_LIMIT = 3;
const TWENTY_FOUR_HOUR_LIMIT = 10;

type RateLimitRow = { count: number };

async function consumeWindow(
  id: string,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<boolean> {
  const cutoff = BigInt(nowMs - windowMs);
  const now = BigInt(nowMs);
  const cap = limit + 1;

  const rows = await prisma.$queryRaw<RateLimitRow[]>`
    INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest")
    VALUES (${id}, ${key}, 1, ${now})
    ON CONFLICT ("id") DO UPDATE SET
      "count" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN 1
        ELSE LEAST("rateLimit"."count" + 1, ${cap})
      END,
      "lastRequest" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN ${now}
        ELSE "rateLimit"."lastRequest"
      END
    RETURNING "count"
  `;

  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count)) {
    throw new Error("Contact rate-limit storage returned an invalid result");
  }

  return rows[0]!.count <= limit;
}

export async function consumeContactRateLimits(
  clientBucket: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const [shortWindowAllowed, dailyWindowAllowed] = await Promise.all([
    consumeWindow(
      `contact:15m:${clientBucket}`,
      `contact:15m:${clientBucket}`,
      FIFTEEN_MINUTE_LIMIT,
      FIFTEEN_MINUTES_MS,
      nowMs,
    ),
    consumeWindow(
      `contact:24h:${clientBucket}`,
      `contact:24h:${clientBucket}`,
      TWENTY_FOUR_HOUR_LIMIT,
      TWENTY_FOUR_HOURS_MS,
      nowMs,
    ),
  ]);

  return shortWindowAllowed && dailyWindowAllowed;
}
