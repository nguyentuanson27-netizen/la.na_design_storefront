import { prisma } from "../db/prisma.ts";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

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

  const rows = await prisma.$queryRaw<RateLimitRow[]>`
    INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest")
    VALUES (${id}, ${key}, 1, ${now})
    ON CONFLICT ("id") DO UPDATE SET
      "count" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN 1
        ELSE "rateLimit"."count" + 1
      END,
      "lastRequest" = CASE
        WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN ${now}
        ELSE "rateLimit"."lastRequest"
      END
    RETURNING "count"
  `;

  return rows.length === 1 && rows[0]!.count <= limit;
}

export async function consumeContactRateLimits(
  clientBucket: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const [shortWindowAllowed, dailyWindowAllowed] = await Promise.all([
    consumeWindow(
      `contact:15m:${clientBucket}`,
      `contact:15m:${clientBucket}`,
      3,
      FIFTEEN_MINUTES_MS,
      nowMs,
    ),
    consumeWindow(
      `contact:24h:${clientBucket}`,
      `contact:24h:${clientBucket}`,
      10,
      TWENTY_FOUR_HOURS_MS,
      nowMs,
    ),
  ]);

  return shortWindowAllowed && dailyWindowAllowed;
}
