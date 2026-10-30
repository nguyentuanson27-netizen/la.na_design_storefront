import type { Prisma } from "../generated/prisma/client.ts";

/**
 * Read-through memo for ONE read-only, REPEATABLE READ transaction.
 *
 * A recommendation prices the same cart once per candidate. Every pass re-reads campaigns, targets,
 * policies and options that cannot differ: inside a repeatable-read snapshot an identical query
 * returns identical rows. Only the per-candidate queries (different variant ids) still hit the DB.
 *
 * Safety contract:
 * - Wrap only transactions that never write (recommend, requote). `add` locks and inserts: never wrap it.
 * - Only Prisma model reads are memoized. Raw SQL (`$queryRaw`) and `$executeRaw` pass straight through.
 * - Cached rows are deep-frozen. A caller that mutates a shared row (an in-place sort, for example)
 *   throws instead of silently corrupting the next quote; the optional read then fails closed.
 */
const READ_OPERATIONS = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);

export type TxReadMemoStats = { hits: number; misses: number };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function keyOf(model: string, operation: string, args: unknown): string {
  return `${model}.${operation}:${JSON.stringify(args ?? null, (_key, value) => typeof value === "bigint" ? `${value}n` : value)}`;
}

export function memoizeTransactionReads(tx: Prisma.TransactionClient, stats?: TxReadMemoStats): Prisma.TransactionClient {
  const results = new Map<string, Promise<unknown>>();
  const delegates = new Map<string | symbol, unknown>();
  return new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      // Model delegates are the lower-camel objects (`variantMirror`); `$`-prefixed members are client API.
      if (typeof property !== "string" || property.startsWith("$") || value === null || typeof value !== "object") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const cached = delegates.get(property);
      if (cached) return cached;
      const delegate = new Proxy(value as Record<string, unknown>, {
        get(model, operation, modelReceiver) {
          const member = Reflect.get(model, operation, modelReceiver) as unknown;
          if (typeof operation !== "string" || typeof member !== "function") return member;
          if (!READ_OPERATIONS.has(operation)) return member.bind(model);
          return (args?: unknown) => {
            const key = keyOf(property, operation, args);
            const hit = results.get(key);
            if (hit) { if (stats) stats.hits++; return hit; }
            if (stats) stats.misses++;
            const pending = Promise.resolve((member as (a?: unknown) => PromiseLike<unknown>).call(model, args)).then(deepFreeze);
            results.set(key, pending);
            // A failed read is never replayed; the transaction is aborted by the caller anyway.
            pending.catch(() => { if (results.get(key) === pending) results.delete(key); });
            return pending;
          };
        },
      });
      delegates.set(property, delegate);
      return delegate;
    },
  });
}
