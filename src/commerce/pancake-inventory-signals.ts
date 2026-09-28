/**
 * Pancake `variations_warehouses` webhook intake.
 *
 * A webhook is a **trigger, never a quantity**. Its only job is to record that a variation's stock
 * in a warehouse may have changed; the 30-second batch worker then reads the authoritative state
 * from Pancake and writes it through the guarded catalog path. So nothing in a payload can move
 * stock, a forged or stale quantity has nothing to act on, and duplicate or out-of-order deliveries
 * are harmless by construction: they collapse into one marker per (variation, warehouse), and the
 * value written is whatever Pancake says when the batch reads it.
 *
 * PAYLOAD CONTRACT — PENDING OPENAPI CONFIRMATION. The reviewed Pancake contract in this repository
 * (`docs/integrations/pancake.md`) does not yet cover webhook payloads. `parseVariationsWarehousesWebhook`
 * accepts the `variations_warehouses` row shape already reviewed for the catalog
 * (`variation_id`/`warehouse_id`), as the body itself, as `data`, or as an array under `data`, and
 * rejects anything else. Anything it rejects is logged and dropped; the hourly reconciliation still
 * converges the mirror, so a contract mismatch degrades freshness, never correctness.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { Prisma } from "../generated/prisma/client.ts";

/** Configured as a custom header on the Pancake webhook; its value is `PANCAKE_WEBHOOK_SECRET`. */
export const PANCAKE_WEBHOOK_SECRET_HEADER = "x-pancake-webhook-secret";
export const PANCAKE_INVENTORY_WEBHOOK_TYPE = "variations_warehouses";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS_PER_PAYLOAD = 1_000;
const MAX_ID_LENGTH = 512;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type InventoryWebhookEvent = Readonly<{ variationId: string; warehouseId: string }>;

export type ParsedInventoryWebhook =
  | Readonly<{ ok: true; events: readonly InventoryWebhookEvent[] }>
  | Readonly<{ ok: false; reason: "malformed" | "too-large" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
    ? value
    : null;
}

/**
 * Extracts the (variation, warehouse) pairs a payload names. A payload of another webhook type is
 * accepted with no events, so a shared endpoint never makes Pancake retry what it cannot use. Any
 * quantity in the payload is ignored on purpose.
 */
export function parseVariationsWarehousesWebhook(body: unknown): ParsedInventoryWebhook {
  if (!isRecord(body)) return { ok: false, reason: "malformed" };
  const type = body.type ?? body.event ?? body.webhook_type;
  if (type !== undefined && type !== PANCAKE_INVENTORY_WEBHOOK_TYPE) return { ok: true, events: [] };

  const rows = Array.isArray(body.data) ? body.data : isRecord(body.data) ? [body.data] : [body];
  if (rows.length === 0) return { ok: false, reason: "malformed" };
  if (rows.length > MAX_EVENTS_PER_PAYLOAD) return { ok: false, reason: "too-large" };

  const events: InventoryWebhookEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return { ok: false, reason: "malformed" };
    const variationId = boundedId(row.variation_id);
    const warehouseId = boundedId(row.warehouse_id);
    if (variationId === null || warehouseId === null) return { ok: false, reason: "malformed" };
    events.push({ variationId, warehouseId });
  }
  return { ok: true, events };
}

function sameSecret(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  // Hash both sides so the comparison is constant-time regardless of the presented length.
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(presented).digest();
  return timingSafeEqual(left, right);
}

export type InventoryWebhookDependencies = Readonly<{
  /** `PANCAKE_WEBHOOK_SECRET`; the endpoint is disabled (503) without one. */
  secret: string | undefined;
  record: (events: readonly InventoryWebhookEvent[], receivedAt: Date) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}>;

/**
 * The webhook endpoint. Never throws: every failure is a fixed log line and a status. 2xx only once
 * the markers are durably recorded, so Pancake's own retry (if any) covers a database outage; a
 * payload that cannot be understood is a 400 that no retry will fix.
 */
export async function handlePancakeInventoryWebhook(
  request: Request,
  { secret, record, now = () => new Date(), log = (line) => console.log(line) }: InventoryWebhookDependencies,
): Promise<Response> {
  try {
    if (!secret) return Response.json({ error: "disabled" }, { status: 503 });
    if (!sameSecret(secret, request.headers.get(PANCAKE_WEBHOOK_SECRET_HEADER))) {
      log("pancake inventory webhook rejected: unauthorized");
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      log("pancake inventory webhook rejected: payload too large");
      return Response.json({ error: "too-large" }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      log("pancake inventory webhook rejected: payload too large");
      return Response.json({ error: "too-large" }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      log("pancake inventory webhook rejected: invalid JSON");
      return Response.json({ error: "invalid" }, { status: 400 });
    }
    const parsed = parseVariationsWarehousesWebhook(body);
    if (!parsed.ok) {
      log(`pancake inventory webhook rejected: ${parsed.reason} payload`);
      return Response.json({ error: "invalid" }, { status: parsed.reason === "too-large" ? 413 : 400 });
    }
    if (parsed.events.length === 0) return Response.json({ accepted: 0 }, { status: 202 });

    try {
      await record(parsed.events, now());
    } catch {
      log("pancake inventory webhook failed: markers could not be recorded");
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    log(`pancake inventory webhook accepted: ${parsed.events.length} events`);
    return Response.json({ accepted: parsed.events.length }, { status: 202 });
  } catch {
    log("pancake inventory webhook failed unexpectedly");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

export type PendingInventorySignal = Readonly<{
  pancakeVariationId: string;
  pancakeWarehouseId: string;
  receivedCount: number;
  lastReceivedAt: Date;
  attempts: number;
}>;

type SignalClient = Pick<PrismaClient, "$executeRaw" | "pancakeInventorySignal" | "variantMirror">;

export function createInventorySignalRepository(client: SignalClient) {
  /**
   * Idempotent: one row per (variation, warehouse). A redelivery or a burst for the same key only
   * bumps the count and moves `lastReceivedAt` forward — never backward, whatever order deliveries
   * arrive in — so the marker always means "changed at or before this instant".
   */
  async function record(events: readonly InventoryWebhookEvent[], receivedAt: Date): Promise<void> {
    const counts = new Map<string, { event: InventoryWebhookEvent; count: number }>();
    for (const event of events) {
      const key = `${event.variationId}\u0000${event.warehouseId}`;
      const entry = counts.get(key) ?? { event, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    if (counts.size === 0) return;
    const rows = [...counts.values()].map(
      ({ event, count }) =>
        Prisma.sql`(${event.variationId}, ${event.warehouseId}, ${count}, ${receivedAt}, ${receivedAt})`,
    );
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "PancakeInventorySignal"
        ("pancakeVariationId", "pancakeWarehouseId", "receivedCount", "firstReceivedAt", "lastReceivedAt")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("pancakeVariationId", "pancakeWarehouseId") DO UPDATE SET
        "receivedCount" = LEAST(
          "PancakeInventorySignal"."receivedCount"::bigint + EXCLUDED."receivedCount",
          ${MAX_POSTGRES_INTEGER}
        )::integer,
        "lastReceivedAt" = GREATEST("PancakeInventorySignal"."lastReceivedAt", EXCLUDED."lastReceivedAt")
    `);
  }

  async function listPending(limit: number): Promise<PendingInventorySignal[]> {
    return client.pancakeInventorySignal.findMany({
      orderBy: [{ lastReceivedAt: "asc" }],
      take: limit,
      select: {
        pancakeVariationId: true,
        pancakeWarehouseId: true,
        receivedCount: true,
        lastReceivedAt: true,
        attempts: true,
      },
    });
  }

  /** The Pancake product owning each known variation of this shop, for the authoritative read. */
  async function productIdsFor(shopId: number, variationIds: readonly string[]): Promise<Map<string, string>> {
    if (variationIds.length === 0) return new Map();
    const variants = await client.variantMirror.findMany({
      where: { pancakeVariationId: { in: [...variationIds] }, product: { pancakeShopId: shopId } },
      select: { pancakeVariationId: true, product: { select: { pancakeProductId: true } } },
    });
    return new Map(variants.map((variant) => [variant.pancakeVariationId, variant.product.pancakeProductId]));
  }

  /**
   * Clears markers a read covered. Guarded on `lastReceivedAt`: a delivery that arrived after the
   * batch claimed its markers keeps its row, because the read may have started before that change.
   */
  async function resolve(signals: readonly PendingInventorySignal[], claimedAt: Date): Promise<number> {
    let resolved = 0;
    for (const signal of signals) {
      const { count } = await client.pancakeInventorySignal.deleteMany({
        where: {
          pancakeVariationId: signal.pancakeVariationId,
          pancakeWarehouseId: signal.pancakeWarehouseId,
          lastReceivedAt: { lte: claimedAt },
        },
      });
      resolved += count;
    }
    return resolved;
  }

  /**
   * Records a failed read. A marker is retried each batch until `maxAttempts`, then dropped: by then
   * the hourly reconciliation is the faster path to the right stock, and a permanently failing
   * variation must not grow the queue forever.
   */
  async function recordFailure(
    signals: readonly PendingInventorySignal[],
    maxAttempts: number,
  ): Promise<{ retried: number; dropped: number }> {
    let dropped = 0;
    for (const signal of signals) {
      const key = {
        pancakeVariationId: signal.pancakeVariationId,
        pancakeWarehouseId: signal.pancakeWarehouseId,
      };
      if (signal.attempts + 1 >= maxAttempts) {
        dropped += (await client.pancakeInventorySignal.deleteMany({ where: key })).count;
      } else {
        await client.pancakeInventorySignal.updateMany({ where: key, data: { attempts: { increment: 1 } } });
      }
    }
    return { retried: signals.length - dropped, dropped };
  }

  return { record, listPending, productIdsFor, resolve, recordFailure };
}
