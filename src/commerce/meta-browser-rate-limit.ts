import type { PrismaClient } from "../generated/prisma/client.ts";

type LimitClient = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
const WINDOW_MS = 60_000;

/** Reuse atomic DB buckets so replicas share the same anonymous transport budget; no raw IP. */
export async function consumeMetaBrowserRateLimit(client: LimitClient, clientKey: string, now = new Date()): Promise<boolean> {
  if (!/^v1:[0-9a-f]{64}$/.test(clientKey) || !Number.isSafeInteger(now.getTime())) return false;
  const nowMs = BigInt(now.getTime());
  const cutoff = nowMs - BigInt(WINDOW_MS);
  for (const [bucket, limit] of [[clientKey, 60], ["global", 600]] as const) {
    const key = `meta-signal:${bucket}`;
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "rateLimit" AS existing ("id", "key", "count", "lastRequest")
      VALUES (${key}, ${key}, 1, ${nowMs})
      ON CONFLICT ("id") DO UPDATE SET
        "count" = CASE WHEN existing."lastRequest" <= ${cutoff} THEN 1
          ELSE LEAST(existing."count" + 1, ${limit + 1}) END,
        "lastRequest" = CASE WHEN existing."lastRequest" <= ${cutoff} THEN ${nowMs}
          ELSE existing."lastRequest" END
      RETURNING "count"
    `;
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count) || rows[0]!.count > limit) return false;
  }
  // Bounded cleanup of this endpoint's expired pseudonymous keys; other limiters are untouched.
  const staleBefore = nowMs - BigInt(24 * 60 * 60_000);
  await client.$executeRaw`
    WITH stale AS (
      SELECT "id" FROM "rateLimit" WHERE "id" LIKE 'meta-signal:%'
        AND "lastRequest" <= ${staleBefore}
      ORDER BY "lastRequest", "id" LIMIT 20 FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "rateLimit" AS target USING stale WHERE target."id" = stale."id"
  `;
  return true;
}
