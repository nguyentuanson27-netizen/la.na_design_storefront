import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { benefitQuoteDigest, issueBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { validateQuoteStructure } from "../../src/commerce/order-quote-rules.ts";

import {
  readOrderQuoteSnapshot,
  replaceOrderQuoteSnapshot,
  type OrderQuoteLineInput,
  type OrderQuoteSnapshotInput,
} from "../../src/commerce/order-quote-snapshot.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq15";
const DIGEST = "b".repeat(64);
const ACK = new Date("2026-10-14T10:00:00.000Z");

async function cleanup() {
  // Frozen fixtures cannot re-enter DRAFT through the production state boundary. As the test schema's
  // owner, suspend only that transition trigger during this transaction's fixture cleanup, then
  // restore it before commit. Quote row checks/guards and foreign keys remain enabled throughout.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "OrderMirror" DISABLE TRIGGER "OrderQuoteDraftReentry_guard"');
    await tx.orderMirror.updateMany({ where: { publicCode: { startsWith: P } }, data: { state: "DRAFT" } });
    const snapshots = await tx.orderQuoteSnapshot.findMany({ where: { order: { publicCode: { startsWith: P } } }, select: { id: true } });
    const ids = snapshots.map((snapshot) => snapshot.id);
    await tx.orderQuoteDiscountStep.deleteMany({ where: { line: { snapshotId: { in: ids } } } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: ids } } });
    await tx.orderQuoteEntitlement.deleteMany({ where: { snapshotId: { in: ids } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { id: { in: ids } } });
    await tx.orderMirror.deleteMany({ where: { publicCode: { startsWith: P } } });
    await tx.$executeRawUnsafe('ALTER TABLE "OrderMirror" ENABLE TRIGGER "OrderQuoteDraftReentry_guard"');
  });
}

let counter = 0;
async function order(state: "DRAFT" | "VALIDATING" | "CONFIRMED" = "DRAFT") {
  counter += 1;
  return prisma.orderMirror.create({ data: { publicCode: `${P}-${process.pid}-${counter}`, state } });
}

function paid(lineId: string, quantity: number, unitPriceVnd: number, extra: Partial<OrderQuoteLineInput> = {}): OrderQuoteLineInput {
  return {
    lineId, role: "PAID", variantId: "variant-1", pancakeVariationId: "var-1", quantity, unitPriceVnd,
    lineTotalVnd: quantity * unitPriceVnd, baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: null, discountSteps: [], ...extra,
  };
}

function gift(lineId: string, quantity: number, campaignId = "camp-1", extra: Partial<OrderQuoteLineInput> = {}): OrderQuoteLineInput {
  return {
    lineId, role: "GIFT", variantId: "variant-1", pancakeVariationId: "var-1", quantity, unitPriceVnd: 0, lineTotalVnd: 0,
    baseUnitPriceVnd: null, fulfillmentState: "READY", campaign: { id: campaignId, revision: 3 }, discountSteps: [], ...extra,
  };
}

const tierStep = { campaignId: "tier-1", source: "QUANTITY_TIER" as const, campaignKind: "QUANTITY_TIER", priority: 1, inputPriceVnd: 100_001, outputPriceVnd: 90_001, appliedQuantity: 1 };

/** EX-17: one variation, 2 x 100.001d + 1 x 90.001d. */
function ex17(overrides: Partial<OrderQuoteSnapshotInput> = {}): OrderQuoteSnapshotInput {
  const input: OrderQuoteSnapshotInput = {
    quoteFormat: "laq3", quoteDigest: DIGEST, paidSubtotalVnd: 290_003, shippingFeeVnd: 30_000, totalVnd: 320_003,
    lines: [paid("P:var-1:0", 2, 100_001), paid("P:var-1:1", 1, 90_001, { baseUnitPriceVnd: 100_001, discountSteps: [tierStep] })],
    entitlements: [], acknowledgedAt: null, ...overrides,
  };
  return { ...input, quoteDigest: overrides.quoteDigest ?? (validateQuoteStructure(input).ok ? benefitQuoteDigest(input) : DIGEST) };
}

/** EX-18 flavour: a paid unit and a gift unit of the SAME variation, 2 of 3 gift slots not taken. */
function paidAndGift(overrides: Partial<OrderQuoteSnapshotInput> = {}): OrderQuoteSnapshotInput {
  const input: OrderQuoteSnapshotInput = {
    quoteFormat: "laq3", quoteDigest: DIGEST, paidSubtotalVnd: 99_000, shippingFeeVnd: 30_000, totalVnd: 129_000,
    lines: [paid("P:var-1:0", 1, 99_000), gift("G:camp-1:var-1", 1)],
    entitlements: [{ campaignId: "camp-1", campaignRevision: 3, entitled: 3, selected: 1, skippedWhileAvailable: 1, contendedForSharedStock: 0, shortForStock: 1 }],
    acknowledgedAt: ACK, ...overrides,
  };
  return { ...input, quoteDigest: overrides.quoteDigest ?? (validateQuoteStructure(input).ok ? benefitQuoteDigest(input) : DIGEST) };
}

async function write(orderId: string, input: OrderQuoteSnapshotInput) {
  return prisma.$transaction((tx) => replaceOrderQuoteSnapshot(tx, orderId, input));
}

async function rejects(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, (error: unknown) => {
    const text = `${error instanceof Error ? error.message : String(error)} ${(error as { cause?: { message?: string } })?.cause?.message ?? ""}`;
    assert.match(text, pattern);
    return true;
  });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("EX-17: two PAID segments of one variation at different prices are stored side by side and read back unmerged", async () => {
  const draft = await order();
  assert.deepEqual(await write(draft.id, ex17()), { ok: true });

  const stored = await readOrderQuoteSnapshot(prisma, draft.id);
  assert.ok(stored);
  assert.equal(stored.paidSubtotalVnd, 290_003);
  assert.equal(stored.paidQuantity, 3);
  assert.equal(stored.totalVnd, 320_003);
  assert.equal(stored.nonclaimAcknowledged, false);
  assert.deepEqual(stored.lines.map((line) => [line.lineId, line.pancakeVariationId, line.quantity, line.unitPriceVnd, line.lineTotalVnd]), [
    ["P:var-1:0", "var-1", 2, 100_001, 200_002],
    ["P:var-1:1", "var-1", 1, 90_001, 90_001],
  ]);
  assert.deepEqual(stored.lines[1]!.discountSteps, [tierStep]);
  assert.equal(stored.lines[1]!.baseUnitPriceVnd, 100_001);
  // The legacy per-variation table is untouched: this record is additive.
  assert.equal(await prisma.orderLineSnapshot.count({ where: { orderId: draft.id } }), 0);
});

test("a gift of the same variation as a paid unit is its own 0d READY line, and the slots not taken are kept with the acknowledgement", async () => {
  const draft = await order();
  assert.deepEqual(await write(draft.id, paidAndGift()), { ok: true });
  const stored = (await readOrderQuoteSnapshot(prisma, draft.id))!;
  assert.deepEqual(stored.lines.map((line) => [line.role, line.unitPriceVnd, line.campaign?.id ?? null]), [["PAID", 99_000, null], ["GIFT", 0, "camp-1"]]);
  assert.equal(stored.giftQuantity, 1);
  assert.equal(stored.unclaimedSlots, 2);
  assert.equal(stored.nonclaimAcknowledged, true);
  assert.deepEqual(stored.acknowledgedAt, ACK);
  assert.deepEqual(stored.entitlements, [{ campaignId: "camp-1", campaignRevision: 3, entitled: 3, selected: 1, skippedWhileAvailable: 1, contendedForSharedStock: 0, shortForStock: 1 }]);
});

test("legacy orders have no snapshot and are read exactly as before: nothing is fabricated", async () => {
  const legacy = await order();
  await prisma.orderLineSnapshot.create({
    data: { orderId: legacy.id, variantId: "legacy-variant", pancakeVariationId: "legacy-var", productName: "Legacy", size: "M", quantity: 2, unitPriceVnd: BigInt(100_000), lineTotalVnd: BigInt(200_000) },
  });
  assert.equal(await readOrderQuoteSnapshot(prisma, legacy.id), null);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: legacy.id } }), 0);
  assert.equal(await readOrderQuoteSnapshot(prisma, "no-such-order"), null);
  const lines = await prisma.orderLineSnapshot.findMany({ where: { orderId: legacy.id } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.unitPriceVnd, BigInt(100_000));
});

test("a re-quote of a DRAFT replaces the whole set; a retry with the same facts leaves the same rows", async () => {
  const draft = await order();
  await write(draft.id, ex17());
  const rowCounts = async () => [
    await prisma.orderQuoteSnapshot.count({ where: { orderId: draft.id } }),
    await prisma.orderQuoteLine.count({ where: { snapshot: { orderId: draft.id } } }),
    await prisma.orderQuoteDiscountStep.count({ where: { line: { snapshot: { orderId: draft.id } } } }),
    await prisma.orderQuoteEntitlement.count({ where: { snapshot: { orderId: draft.id } } }),
  ];
  assert.deepEqual(await rowCounts(), [1, 2, 1, 0]);
  await write(draft.id, ex17());
  assert.deepEqual(await rowCounts(), [1, 2, 1, 0]);

  await write(draft.id, paidAndGift());
  assert.deepEqual(await rowCounts(), [1, 2, 0, 1]);
  assert.equal((await readOrderQuoteSnapshot(prisma, draft.id))!.paidSubtotalVnd, 99_000);
});

test("an invalid quote never reaches the database: the writer refuses it and the previous quote survives", async () => {
  const draft = await order();
  await write(draft.id, ex17());
  const result = await write(draft.id, ex17({ paidSubtotalVnd: 290_002, totalVnd: 320_002 }));
  assert.deepEqual(result, { ok: false, reason: "SNAPSHOT_INVALID", issue: "PAID_SUBTOTAL_MISMATCH" });
  assert.equal((await readOrderQuoteSnapshot(prisma, draft.id))!.paidSubtotalVnd, 290_003);
});

test("unsupported quote formats are rejected by both writer and database without replacing the quote", async () => {
  const draft = await order();
  const original = ex17();
  await write(draft.id, original);
  const snapshot = (await prisma.orderQuoteSnapshot.findUniqueOrThrow({ where: { orderId: draft.id } }));
  const rawDigest = benefitQuoteDigest(ex17({ lines: [paid("P:base", 1, 100, { pancakeVariationId: "x" })], paidSubtotalVnd: 100, shippingFeeVnd: 0, totalVnd: 100 }));
  for (const quoteFormat of ["laq2", "laq4", "laq999"]) {
    assert.deepEqual(await write(draft.id, { ...original, quoteFormat }), { ok: false, reason: "SNAPSHOT_INVALID", issue: "FORMAT_INVALID" });
    await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: snapshot.id }, data: { quoteFormat } }), /check constraint|violates/i);
    const target = await order();
    await rejects(() => rawSnapshot(target.id, { quoteFormat, quoteDigest: rawDigest }), /check constraint|violates/i);
    assert.equal((await prisma.orderQuoteSnapshot.findUniqueOrThrow({ where: { orderId: draft.id } })).id, snapshot.id);
    assert.equal((await readOrderQuoteSnapshot(prisma, draft.id))!.quoteFormat, "laq3");
  }
});

test("a digest from different same-total segments is refused before replacing the stored quote", async () => {
  const draft = await order();
  const original = ex17();
  await write(draft.id, original);
  const changed = ex17({ lines: [paid("P:var-1:0", 1, 100_001), paid("P:var-1:1", 1, 190_002)] });
  assert.equal(original.totalVnd, changed.totalVnd);
  assert.deepEqual(await write(draft.id, { ...changed, quoteDigest: original.quoteDigest }), { ok: false, reason: "SNAPSHOT_INVALID", issue: "DIGEST_MISMATCH" });
  assert.deepEqual((await readOrderQuoteSnapshot(prisma, draft.id))!.lines, original.lines);
  assert.deepEqual(await write(draft.id, changed), { ok: true });
  const stored = (await readOrderQuoteSnapshot(prisma, draft.id))!;
  assert.equal(stored.quoteDigest, benefitQuoteDigest(stored));
});

test("signable INTEGER boundary quantities and priorities round trip through the snapshot", async () => {
  const max = 2_147_483_647;
  for (const priority of [-2_147_483_648, max]) {
    const input = ex17({
      lines: [paid("P:a", max, 1, { baseUnitPriceVnd: 1, discountSteps: [{ ...tierStep, inputPriceVnd: 1, outputPriceVnd: 1, priority, appliedQuantity: max }] })],
      paidSubtotalVnd: max, shippingFeeVnd: 0, totalVnd: max,
    });
    assert.ok(issueBenefitQuoteProof({ quote: input, cartId: "test-cart", secret: "test-secret-at-least-32-characters-long" }));
    const draft = await order();
    assert.deepEqual(await write(draft.id, input), { ok: true });
    const stored = (await readOrderQuoteSnapshot(prisma, draft.id))!;
    assert.equal(stored.paidQuantity, max);
    assert.equal(stored.lines[0]!.discountSteps[0]!.priority, priority);
  }
});

/** Observe an actual lock wait, rather than assuming a query blocked because a timer elapsed. */
async function waitForBlock(observer: Client, waiterPid: number, blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [blockerPid, waiterPid]);
    if (rows[0]!.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("expected the concurrent transaction to wait for the order row lock");
}

test("quote writes and the DRAFT exit serialize in both transaction orders", async () => {
  const writer = new Client({ connectionString });
  const transition = new Client({ connectionString });
  const observer = new Client({ connectionString });
  await Promise.all([writer.connect(), transition.connect(), observer.connect()]);
  try {
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const transitionPid = (await transition.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    for (const writerFirst of [true, false]) {
      const draft = await order();
      await write(draft.id, ex17());
      const snapshot = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: draft.id }, include: { lines: true } }))!;
      const line = snapshot.lines[0]!;
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await transition.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // A real child-row change which preserves all monetary/quantity invariants.
      const editQuote = () => writer.query('UPDATE "OrderQuoteLine" SET "variantId" = $1 WHERE "id" = $2', ["changed-variant", line.id]);
      const leaveDraft = () => transition.query('UPDATE "OrderMirror" SET "state" = \'VALIDATING\' WHERE "id" = $1', [draft.id]);
      if (writerFirst) {
        await editQuote();
        const pending = leaveDraft();
        const completed = pending.then(() => null, error => error as Error);
        try {
          await waitForBlock(observer, transitionPid, writerPid);
          await writer.query("COMMIT");
          assert.equal(await completed, null);
          await transition.query("COMMIT");
        } finally {
          await writer.query("ROLLBACK");
          await completed;
        }
        assert.equal((await prisma.orderQuoteLine.findUniqueOrThrow({ where: { id: line.id } })).variantId, "changed-variant");
      } else {
        await leaveDraft();
        const pending = editQuote();
        const completed = pending.then(() => null, error => error as Error);
        try {
          await waitForBlock(observer, writerPid, transitionPid);
          await transition.query("COMMIT");
          const error = await completed;
          assert.ok(error);
          assert.match(error.message, /immutable/i);
          await writer.query("ROLLBACK");
        } finally {
          await transition.query("ROLLBACK");
          await completed;
        }
        assert.equal((await prisma.orderQuoteLine.findUniqueOrThrow({ where: { id: line.id } })).variantId, line.variantId);
      }
      assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: draft.id } })).state, "VALIDATING");
      await rejects(editQuote, /immutable/i);
    }
  } finally {
    await Promise.all([writer.query("ROLLBACK"), transition.query("ROLLBACK")]);
    await Promise.all([writer.end(), transition.end(), observer.end()]);
  }
});

test("a failed write rolls back with its transaction and does not half-replace the previous quote", async () => {
  const draft = await order();
  await write(draft.id, ex17());
  await rejects(
    () => prisma.$transaction(async (tx) => {
      await replaceOrderQuoteSnapshot(tx, draft.id, paidAndGift());
      throw new Error("downstream failure");
    }),
    /downstream failure/,
  );
  const stored = (await readOrderQuoteSnapshot(prisma, draft.id))!;
  assert.equal(stored.paidSubtotalVnd, 290_003);
  assert.equal(stored.lines.length, 2);
});

test("the quote is frozen once the order leaves DRAFT: no replace, update, insert or delete, and the order cannot be removed", async () => {
  const frozen = await order();
  await write(frozen.id, paidAndGift());
  await prisma.orderMirror.update({ where: { id: frozen.id }, data: { state: "VALIDATING" } });

  await rejects(() => write(frozen.id, paidAndGift()), /immutable/i);
  const snapshot = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: frozen.id }, include: { lines: true } }))!;
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: snapshot.id }, data: { totalVnd: BigInt(1) } }), /immutable/i);
  await rejects(() => prisma.orderQuoteLine.update({ where: { id: snapshot.lines[0]!.id }, data: { quantity: 9, lineTotalVnd: BigInt(900_009) } }), /immutable/i);
  await rejects(() => prisma.orderQuoteLine.delete({ where: { id: snapshot.lines[0]!.id } }), /immutable/i);
  await rejects(() => prisma.orderQuoteDiscountStep.create({ data: { lineRowId: snapshot.lines[0]!.id, position: 0, campaignId: "c", source: "LEGACY", campaignKind: "FLASH_SALE", inputPriceVnd: BigInt(2), outputPriceVnd: BigInt(1), appliedQuantity: 1 } }), /immutable/i);
  await rejects(
    () => prisma.orderQuoteLine.create({ data: { snapshotId: snapshot.id, lineId: "P:extra", role: "PAID", variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(5), lineTotalVnd: BigInt(5), fulfillmentState: "READY" } }),
    /immutable/i,
  );
  await rejects(() => prisma.orderQuoteEntitlement.deleteMany({ where: { snapshotId: snapshot.id } }), /immutable/i);
  await rejects(() => prisma.orderMirror.delete({ where: { id: frozen.id } }), /foreign key|violates|restrict/i);

  const stored = (await readOrderQuoteSnapshot(prisma, frozen.id))!;
  assert.equal(stored.paidSubtotalVnd, 99_000);
  assert.equal(stored.lines.length, 2);
  assert.equal(stored.entitlements.length, 1);
});

test("an order that is not a DRAFT cannot receive a first quote either", async () => {
  const confirmed = await order("CONFIRMED");
  await rejects(() => write(confirmed.id, ex17()), /immutable/i);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: confirmed.id } }), 0);
});

test("the first DRAFT exit prevents re-entry and keeps quote rows immutable for writer and direct writes", async () => {
  for (const state of ["VALIDATING", "CONFIRMED"] as const) {
    const draft = await order();
    const original = ex17({
      lines: [...ex17().lines, gift("G:camp-1:var-1", 1)],
      entitlements: paidAndGift().entitlements, acknowledgedAt: ACK,
    });
    await write(draft.id, original);
    const before = (await readOrderQuoteSnapshot(prisma, draft.id))!;
    const snapshot = await prisma.orderQuoteSnapshot.findUniqueOrThrow({ where: { orderId: draft.id }, include: { lines: { include: { discountSteps: true } }, entitlements: true } });
    await prisma.orderMirror.update({ where: { id: draft.id }, data: { state } });
    await rejects(() => prisma.orderMirror.update({ where: { id: draft.id }, data: { state: "DRAFT" } }), /cannot return to DRAFT/i);
    assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: draft.id } })).state, state);
    await rejects(() => write(draft.id, paidAndGift()), /immutable/i);
    await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: snapshot.id }, data: { quoteDigest: DIGEST } }), /immutable/i);
    await rejects(() => prisma.orderQuoteLine.update({ where: { id: snapshot.lines[0]!.id }, data: { variantId: "changed" } }), /immutable/i);
    const step = snapshot.lines.flatMap(line => line.discountSteps)[0]!;
    await rejects(() => prisma.orderQuoteDiscountStep.update({ where: { id: step.id }, data: { priority: 2 } }), /immutable/i);
    await rejects(() => prisma.orderQuoteEntitlement.update({ where: { id: snapshot.entitlements[0]!.id }, data: { campaignRevision: 4 } }), /immutable/i);
    assert.deepEqual(await readOrderQuoteSnapshot(prisma, draft.id), before);
    assert.equal((await prisma.orderQuoteSnapshot.findUniqueOrThrow({ where: { orderId: draft.id } })).id, snapshot.id);
  }
});

test("legacy orders without a benefit quote keep VALIDATING -> DRAFT reprice and outage retries", async () => {
  const legacy = await order();
  for (const syncErrorCode of ["PRICE_CHANGED", "VALIDATION_UNAVAILABLE"]) {
    await prisma.orderMirror.update({ where: { id: legacy.id }, data: { state: "VALIDATING" } });
    assert.equal((await prisma.orderMirror.updateMany({ where: { id: legacy.id, state: "VALIDATING" }, data: { state: "DRAFT", syncErrorCode } })).count, 1);
    const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(stored.state, "DRAFT");
    assert.equal(stored.syncErrorCode, syncErrorCode);
    assert.equal(await readOrderQuoteSnapshot(prisma, legacy.id), null);
  }
});

test("a row cannot be moved to another order's quote", async () => {
  const first = await order();
  const second = await order();
  await write(first.id, ex17());
  await write(second.id, ex17());
  const a = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: first.id }, include: { lines: true } }))!;
  const b = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: second.id } }))!;
  await rejects(() => prisma.orderQuoteLine.update({ where: { id: a.lines[0]!.id }, data: { snapshotId: b.id } }), /cannot be moved/i);
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: a.id }, data: { orderId: second.id } }), /cannot be moved|unique/i);
});

// Everything below bypasses the writer on purpose: the database must refuse these on its own.

/** A consistent one-line quote (100d), so a statement on its own commits; tests then break one thing at a time. */
async function rawSnapshot(orderId: string, data: Record<string, unknown> = {}) {
  return prisma.orderQuoteSnapshot.create({
    data: {
      orderId, quoteFormat: "laq3", quoteDigest: DIGEST, paidSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100),
      paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 0, nonclaimAcknowledged: false,
      lines: { create: { lineId: "P:base", role: "PAID", variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100), fulfillmentState: "READY" } },
      ...data,
    } as never,
    include: { lines: true },
  });
}

const paidRow = (snapshotId: string, lineId = "P:1", extra: Record<string, unknown> = {}) => ({
  snapshotId, lineId, role: "PAID" as const, variantId: "v", pancakeVariationId: "x", quantity: 1, unitPriceVnd: BigInt(100), lineTotalVnd: BigInt(100), fulfillmentState: "READY" as const, ...extra,
});

test("row checks: money, role shape, identity and acknowledgement are enforced by the database itself", async () => {
  const draft = await order();
  const bad = async (data: Record<string, unknown>) => {
    const target = await order();
    return rejects(() => rawSnapshot(target.id, data as never), /check constraint|violates/i);
  };
  await bad({ totalVnd: BigInt(101) });
  await bad({ paidSubtotalVnd: BigInt(0), totalVnd: BigInt(0) });
  await bad({ quoteFormat: "v3" });
  await bad({ quoteDigest: "B".repeat(64) });
  await bad({ paidQuantity: 0 });
  await bad({ giftQuantity: 101 });
  await bad({ unclaimedSlots: 1, nonclaimAcknowledged: false });
  await bad({ nonclaimAcknowledged: true, acknowledgedAt: null });
  await bad({ vendorProjectionHash: "c".repeat(64), vendorProjection: undefined });
  await bad({ vendorProjectionHash: "short", vendorProjection: [] });

  const snapshot = await rawSnapshot(draft.id);
  const line = (data: Record<string, unknown>) => prisma.orderQuoteLine.create({ data: paidRow(snapshot.id, `P:${Math.random().toString(36).slice(2, 10)}`, data) as never });
  assert.equal(snapshot.lines.length, 1);
  await rejects(() => line({ lineTotalVnd: BigInt(99) }), /check constraint|violates/i); // total != quantity x price
  await rejects(() => line({ unitPriceVnd: BigInt(0), lineTotalVnd: BigInt(0) }), /check constraint|violates/i); // a paid line is never free
  await rejects(() => line({ campaignId: "camp-1" }), /check constraint|violates/i); // a paid line has no campaign
  await rejects(() => line({ baseUnitPriceVnd: BigInt(99) }), /check constraint|violates/i); // base below price
  await rejects(() => line({ lineId: "has space" }), /check constraint|violates/i);
  await rejects(() => line({ quantity: 0, lineTotalVnd: BigInt(0) }), /check constraint|violates/i);
  const giftRow = (data: Record<string, unknown>) => prisma.orderQuoteLine.create({ data: { ...paidRow(snapshot.id, `G:${Math.random().toString(36).slice(2, 10)}`), role: "GIFT", unitPriceVnd: BigInt(0), lineTotalVnd: BigInt(0), campaignId: "camp-1", campaignRevision: 1, ...data } as never });
  await rejects(() => giftRow({ unitPriceVnd: BigInt(1), lineTotalVnd: BigInt(1) }), /check constraint|violates/i);
  await rejects(() => giftRow({ fulfillmentState: "PREORDER" }), /check constraint|violates/i);
  await rejects(() => giftRow({ campaignId: null }), /check constraint|violates/i);
  await rejects(() => giftRow({ quantity: 101 }), /check constraint|violates/i);
  await rejects(() => giftRow({ baseUnitPriceVnd: BigInt(1) }), /check constraint|violates/i);
  await rejects(() => prisma.orderQuoteLine.create({ data: paidRow(snapshot.id, "P:base") as never }), /unique/i); // one lineId once per quote
});

test("commit-time totals: paid lines must add up to the subtotal and every gift needs a matching entitlement", async () => {
  const run = async (build: (snapshotId: string, tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>, data: Record<string, unknown> = {}) => {
    const target = await order();
    return prisma.$transaction(async (tx) => {
      const snapshot = await tx.orderQuoteSnapshot.create({
        data: { orderId: target.id, quoteFormat: "laq3", quoteDigest: DIGEST, paidSubtotalVnd: BigInt(100), shippingFeeVnd: BigInt(0), totalVnd: BigInt(100), paidQuantity: 1, giftQuantity: 0, unclaimedSlots: 0, nonclaimAcknowledged: false, ...data } as never,
      });
      await build(snapshot.id, tx);
    });
  };

  // Consistent set passes.
  await run(async (id, tx) => { await tx.orderQuoteLine.create({ data: paidRow(id) as never }); });
  // Paid lines add up to 200 but the subtotal says 100.
  await rejects(() => run(async (id, tx) => { await tx.orderQuoteLine.create({ data: paidRow(id, "P:1", { unitPriceVnd: BigInt(200), lineTotalVnd: BigInt(200) }) as never }); }), /do not add up to the paid subtotal/i);
  // No paid line at all.
  await rejects(() => run(async () => undefined), /do not add up to the paid subtotal/i);
  // Quantity totals disagree with the lines.
  await rejects(() => run(async (id, tx) => { await tx.orderQuoteLine.create({ data: paidRow(id, "P:1", { quantity: 2, lineTotalVnd: BigInt(200), unitPriceVnd: BigInt(100) }) as never }); }, { paidSubtotalVnd: BigInt(200), totalVnd: BigInt(200) }), /quantities do not match/i);
  // A gift line with no entitlement of its campaign.
  await rejects(
    () => run(async (id, tx) => {
      await tx.orderQuoteLine.create({ data: paidRow(id) as never });
      await tx.orderQuoteLine.create({ data: { ...paidRow(id, "G:1"), role: "GIFT", unitPriceVnd: BigInt(0), lineTotalVnd: BigInt(0), campaignId: "camp-1", campaignRevision: 1 } as never });
    }, { giftQuantity: 1 }),
    /no entitlement of its campaign/i,
  );
  // Entitlement says 1 taken, there is no gift line.
  await rejects(
    () => run(async (id, tx) => {
      await tx.orderQuoteLine.create({ data: paidRow(id) as never });
      await tx.orderQuoteEntitlement.create({ data: { snapshotId: id, campaignId: "camp-1", campaignRevision: 1, entitled: 1, selected: 1, unclaimed: 0, skippedWhileAvailable: 0, contendedForSharedStock: 0, shortForStock: 0 } });
    }),
    /does not match the gift lines/i,
  );
  // Entitlement arithmetic is a row check: unclaimed = entitled - selected and the reasons account for it.
  await rejects(
    () => run(async (id, tx) => {
      await tx.orderQuoteLine.create({ data: paidRow(id) as never });
      await tx.orderQuoteEntitlement.create({ data: { snapshotId: id, campaignId: "camp-1", campaignRevision: 1, entitled: 2, selected: 0, unclaimed: 2, skippedWhileAvailable: 1, contendedForSharedStock: 0, shortForStock: 0 } });
    }, { unclaimedSlots: 2, nonclaimAcknowledged: true, acknowledgedAt: ACK }),
    /check constraint|violates/i,
  );
  // Unclaimed slots stored on the snapshot must equal the entitlements'.
  await rejects(
    () => run(async (id, tx) => {
      await tx.orderQuoteLine.create({ data: paidRow(id) as never });
      await tx.orderQuoteEntitlement.create({ data: { snapshotId: id, campaignId: "camp-1", campaignRevision: 1, entitled: 2, selected: 0, unclaimed: 2, skippedWhileAvailable: 2, contendedForSharedStock: 0, shortForStock: 0 } });
    }, { unclaimedSlots: 1, nonclaimAcknowledged: true, acknowledgedAt: ACK }),
    /unclaimed slots/i,
  );
  // A discount step cannot raise the price or reach 0d.
  const snapshot = await rawSnapshot((await order()).id);
  const lineRow = snapshot.lines[0]!;
  const stepRow = (data: Record<string, unknown>) => prisma.orderQuoteDiscountStep.create({ data: { lineRowId: lineRow.id, position: 0, campaignId: "c", source: "LEGACY", campaignKind: "FLASH_SALE", inputPriceVnd: BigInt(100), outputPriceVnd: BigInt(90), appliedQuantity: 1, ...data } as never });
  await rejects(() => stepRow({ outputPriceVnd: BigInt(101) }), /check constraint|violates/i);
  await rejects(() => stepRow({ outputPriceVnd: BigInt(0) }), /check constraint|violates/i);
  await rejects(() => stepRow({ source: "OTHER" }), /check constraint|violates/i);
  await rejects(() => stepRow({ appliedQuantity: 0 }), /check constraint|violates/i);
  await stepRow({});
  await rejects(() => stepRow({}), /unique/i);
});

test("a DRAFT quote cannot be edited into inconsistency one row at a time", async () => {
  const draft = await order();
  await write(draft.id, ex17());
  const snapshot = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: draft.id }, include: { lines: true } }))!;
  const plain = snapshot.lines.find((line) => line.lineId === "P:var-1:0")!;
  await rejects(() => prisma.orderQuoteLine.delete({ where: { id: plain.id } }), /do not add up to the paid subtotal/i);
  await rejects(() => prisma.orderQuoteLine.update({ where: { id: plain.id }, data: { quantity: 3, lineTotalVnd: BigInt(300_003) } }), /do not add up to the paid subtotal/i);
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: snapshot.id }, data: { paidSubtotalVnd: BigInt(1), totalVnd: BigInt(30_001) } }), /do not add up to the paid subtotal/i);
  assert.equal((await readOrderQuoteSnapshot(prisma, draft.id))!.paidSubtotalVnd, 290_003);
});

test("vendor projection columns are both-or-neither and bounded; they stay empty until GQ20 writes them", async () => {
  const draft = await order();
  await write(draft.id, ex17());
  const row = (await prisma.orderQuoteSnapshot.findUnique({ where: { orderId: draft.id } }))!;
  assert.equal(row.vendorProjectionHash, null);
  assert.equal(row.vendorProjection, null);
  await prisma.orderQuoteSnapshot.update({ where: { id: row.id }, data: { vendorProjectionHash: "d".repeat(64), vendorProjection: [{ variation: "var-1", quantity: 1, unitPriceVnd: 1000 }] } });
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: row.id }, data: { vendorProjectionHash: null } }), /check constraint|violates/i);
  await rejects(() => prisma.orderQuoteSnapshot.update({ where: { id: row.id }, data: { vendorProjection: { not: "an array" } } }), /check constraint|violates/i);
});

test("basis snapshots every PAID segment including undiscounted rows, gifts stay null and digest is unchanged",async()=> {
  const product=await prisma.productMirror.create({data:{pancakeShopId:925227,pancakeProductId:"gq15-list-price",slug:"gq15-list-price",name:"Frozen Name",syncedAt:new Date(),variants:{create:{id:"gq15-list-variant",pancakeVariationId:"gq15-list-external",pancakeRetailPrice:100001,size:"M",syncedAt:new Date()}}}});
  try {
    const plain=ex17();
    const facts={...plain,lines:plain.lines.map(line=>({...line,variantId:"gq15-list-variant"}))};
    const old=await order(); assert.deepEqual(await write(old.id,facts),{ok:true});
    const before=await readOrderQuoteSnapshot(prisma,old.id);
    process.env.LIST_PRICE_DISPLAY="true";process.env.LIST_PRICE_CAMPAIGN_BASIS="true";
    const current=await order();assert.deepEqual(await write(current.id,facts),{ok:true});
    assert.deepEqual(await readOrderQuoteSnapshot(prisma,current.id),before);
    const rows=await prisma.orderQuoteLine.findMany({where:{snapshot:{orderId:current.id}}});
    assert.deepEqual(rows.map(row=>row.listUnitPriceVnd),[BigInt(149000),BigInt(149000)]);
    const giftOrder=await order();const giftFacts=paidAndGift();const newGiftFacts={...giftFacts,lines:giftFacts.lines.map(line=>({...line,variantId:"gq15-list-variant"}))};
    assert.deepEqual(await write(giftOrder.id,newGiftFacts),{ok:true});
    const gifts=await prisma.orderQuoteLine.findMany({where:{snapshot:{orderId:giftOrder.id}},orderBy:{role:"asc"}});
    assert.equal(gifts.find(row=>row.role==="GIFT")?.listUnitPriceVnd,null);
    assert.equal(gifts.find(row=>row.role==="PAID")?.listUnitPriceVnd,BigInt(149000));
    assert.equal(gifts.find(row=>row.role==="GIFT")?.productName,"Frozen Name");

  } finally {delete process.env.LIST_PRICE_DISPLAY;delete process.env.LIST_PRICE_CAMPAIGN_BASIS;await prisma.productMirror.delete({where:{id:product.id}});}
});
