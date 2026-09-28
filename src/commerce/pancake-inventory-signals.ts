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
 * Contract (Pancake POS OpenAPI 3.1.0, schema `WebhookInventoryResponse`): a shop has one
 * `webhook_url` for every enabled `webhook_types` entry and a free-form `webhook_headers` map, which
 * is where our secret header is configured. An inventory delivery is
 * `{ data: { record: { variation_id, warehouse_id, remain_quantity, … }, success } }`; the other
 * types (orders, customers, products, auto-call) arrive at the same URL with other shapes and are
 * acknowledged and ignored. `remain_quantity` and the rest of the record are never read.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { Prisma } from "../generated/prisma/client.ts";

/** Configured as a custom header on the Pancake webhook; its value is `PANCAKE_WEBHOOK_SECRET`. */
export const PANCAKE_WEBHOOK_SECRET_HEADER = "x-pancake-webhook-secret";
export const PANCAKE_INVENTORY_WEBHOOK_TYPE = "variations_warehouses";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 512;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type InventoryWebhookEvent = Readonly<{ variationId: string; warehouseId: string }>;

export type ParsedInventoryWebhook =
  | Readonly<{ ok: true; events: readonly InventoryWebhookEvent[] }>
  | Readonly<{ ok: false; reason: "malformed" }>;

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
 * The (variation, warehouse) pair a `variations_warehouses` delivery names. Any other webhook type
 * sharing the URL yields no events, so Pancake is never made to retry what this endpoint does not
 * handle; a delivery that is an inventory record but with unusable ids is malformed.
 */
export function parseVariationsWarehousesWebhook(body: unknown): ParsedInventoryWebhook {
  if (!isRecord(body)) return { ok: false, reason: "malformed" };
  const record = isRecord(body.data) && isRecord(body.data.record) ? body.data.record : null;
  if (record === null || (!("variation_id" in record) && !("warehouse_id" in record))) {
    return { ok: true, events: [] };
  }
  const variationId = boundedId(record.variation_id);
  const warehouseId = boundedId(record.warehouse_id);
  if (variationId === null || warehouseId === null) return { ok: false, reason: "malformed" };
  return { ok: true, events: [{ variationId, warehouseId }] };
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
      return Response.json({ error: "invalid" }, { status: 400 });
    }
    if (parsed.events.length === 0) return Response.json({ accepted: 0 }, { status: 200 });

    try {
      await record(parsed.events, now());
    } catch {
      log("pancake inventory webhook failed: markers could not be recorded");
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    log(`pancake inventory webhook accepted: ${parsed.events.length} events`);
    return Response.json({ accepted: parsed.events.length }, { status: 200 });
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

type SignalClient = Pick<PrismaClient, "$executeRaw" | "pancakeInventorySignal">;

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

  return { record, listPending, resolve, recordFailure };
}
