import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import { memoizeTransactionReads, type TxReadMemoStats } from "../../src/commerce/tx-read-memo.ts";

function fakeTx() {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => { calls.push("raw"); return [1]; },
    productMirror: {
      findMany: async (args: unknown) => { calls.push(`findMany:${JSON.stringify(args, (_k, v) => typeof v === "bigint" ? `${v}n` : v)}`); return [{ id: "p1", tags: ["a"] }]; },
      create: async () => { calls.push("create"); return { id: "new" }; },
      findFirst: async () => { calls.push("findFirst"); throw new Error("db down"); },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

test("identical model reads in one transaction hit the database once", async () => {
  const { tx, calls } = fakeTx(); const stats: TxReadMemoStats = { hits: 0, misses: 0 };
  const memo = memoizeTransactionReads(tx, stats);
  const a = await memo.productMirror.findMany({ where: { id: { in: ["p1"] } } });
  const b = await memo.productMirror.findMany({ where: { id: { in: ["p1"] } } });
  const c = await memo.productMirror.findMany({ where: { id: { in: ["p2"] } } });
  assert.equal(a, b);
  assert.equal(c.length, 1);
  assert.deepEqual(calls.length, 2);
  assert.deepEqual(stats, { hits: 1, misses: 2 });
});

test("BigInt arguments are part of the key and do not throw", async () => {
  const { tx, calls } = fakeTx();
  const memo = memoizeTransactionReads(tx);
  await memo.productMirror.findMany({ where: { pancakeShopId: Number(BigInt(1)) }, take: BigInt(1) as never });
  await memo.productMirror.findMany({ where: { pancakeShopId: Number(BigInt(1)) }, take: BigInt(2) as never });
  await memo.productMirror.findMany({ where: { pancakeShopId: Number(BigInt(1)) }, take: BigInt(1) as never });
  assert.equal(calls.length, 2);
});

test("cached rows are frozen so an in-place mutation fails loudly instead of corrupting later quotes", async () => {
  const { tx } = fakeTx();
  const rows = await memoizeTransactionReads(tx).productMirror.findMany({}) as unknown as { id: string; tags: string[] }[];
  assert.throws(() => rows.push({ id: "x", tags: [] }), TypeError);
  assert.throws(() => { rows[0]!.id = "changed"; }, TypeError);
  assert.throws(() => rows[0]!.tags.push("b"), TypeError);
});

test("writes and raw SQL are never memoized", async () => {
  const { tx, calls } = fakeTx();
  const memo = memoizeTransactionReads(tx) as unknown as { productMirror: { create(): Promise<unknown> }; $queryRaw(): Promise<unknown> };
  await memo.productMirror.create(); await memo.productMirror.create();
  await memo.$queryRaw(); await memo.$queryRaw();
  assert.deepEqual(calls, ["create", "create", "raw", "raw"]);
});

test("a failed read is not replayed from the memo", async () => {
  const { tx, calls } = fakeTx();
  const memo = memoizeTransactionReads(tx);
  await assert.rejects(memo.productMirror.findFirst({}));
  await assert.rejects(memo.productMirror.findFirst({}));
  assert.equal(calls.filter((c) => c === "findFirst").length, 2);
});
