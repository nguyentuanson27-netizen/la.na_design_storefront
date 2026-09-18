import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  observeVariantAvailabilityCycles,
  readVariantAvailabilityDates,
} from "../../src/commerce/availability-cycle-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * I9 — the cycle as it actually behaves against Postgres.
 *
 * The pure domain already proves the rules. What only a database can prove is that they survive
 * persistence: that a `DATE` column round-trips as the same Vietnamese day, that a re-sync is a
 * genuine no-op on the stored row, and that two observers racing cannot produce two cycles.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const syncedAt = new Date("2026-09-18T03:00:00.000Z");
const key = "i9-cycle";

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: key } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedVariant(label: string) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${key}-product-${label}`,
      slug: `${key}-${label}`,
      name: `I9 ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt,
      variants: {
        create: {
          pancakeVariationId: `${key}-variation-${label}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt,
        },
      },
    },
    include: { variants: true },
  });
  return product.variants[0]!;
}

const soldOutOnPreorder = (variantId: string) => [
  { variantId, stockNonPositive: true, isPreorder: true },
];

test("I9 a cycle round-trips through the DATE column as the same Vietnamese day", async () => {
  const variant = await seedVariant("roundtrip");

  // 2026-09-17T18:00Z is already the 18th in Hanoi. A column or conversion that lost the offset
  // would store the 17th and publish a date a day early for every evening sync.
  const dates = await observeVariantAvailabilityCycles(
    prisma,
    soldOutOnPreorder(variant.id),
    new Date("2026-09-17T18:00:00.000Z"),
  );

  assert.equal(dates.get(variant.id), "2026-10-03");
  const stored = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  assert.equal(stored.cycleStartDate?.toISOString(), "2026-09-18T00:00:00.000Z");
  assert.equal(stored.availabilityDate?.toISOString(), "2026-10-03T00:00:00.000Z");

  const readBack = await readVariantAvailabilityDates(prisma, [variant.id]);
  assert.equal(readBack.get(variant.id), "2026-10-03");
});

test("I9 re-running the sync with the same state leaves the stored row untouched", async () => {
  const variant = await seedVariant("resync");
  await observeVariantAvailabilityCycles(prisma, soldOutOnPreorder(variant.id), syncedAt);
  const first = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: variant.id },
  });

  for (const at of ["2026-09-19T03:00:00.000Z", "2026-09-30T03:00:00.000Z", "2026-11-01T03:00:00.000Z"]) {
    const dates = await observeVariantAvailabilityCycles(
      prisma,
      soldOutOnPreorder(variant.id),
      new Date(at),
    );
    assert.equal(dates.get(variant.id), "2026-10-03", `a re-sync at ${at} must not move the date`);
  }

  const after = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  assert.deepEqual(after.cycleStartDate, first.cycleStartDate);
  assert.deepEqual(after.availabilityDate, first.availabilityDate);
});

test("I9 restocking closes the cycle and a later sell-out opens a different one", async () => {
  const variant = await seedVariant("reopen");
  await observeVariantAvailabilityCycles(prisma, soldOutOnPreorder(variant.id), syncedAt);

  await observeVariantAvailabilityCycles(
    prisma,
    [{ variantId: variant.id, stockNonPositive: false, isPreorder: true }],
    new Date("2026-09-20T03:00:00.000Z"),
  );
  const closed = await prisma.variantAvailabilityCycle.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  assert.equal(closed.cycleStartDate, null);
  assert.equal(closed.availabilityDate, null);

  const reopened = await observeVariantAvailabilityCycles(
    prisma,
    soldOutOnPreorder(variant.id),
    new Date("2026-10-01T03:00:00.000Z"),
  );
  assert.equal(reopened.get(variant.id), "2026-10-16", "a new cycle, not a resumed one");
});

test("I9 leaving and re-entering preorder while sold out opens a new cycle", async () => {
  const variant = await seedVariant("toggle");
  await observeVariantAvailabilityCycles(prisma, soldOutOnPreorder(variant.id), syncedAt);

  await observeVariantAvailabilityCycles(
    prisma,
    [{ variantId: variant.id, stockNonPositive: true, isPreorder: false }],
    new Date("2026-09-19T03:00:00.000Z"),
  );
  assert.equal(
    (await prisma.variantAvailabilityCycle.findUniqueOrThrow({ where: { variantId: variant.id } }))
      .availabilityDate,
    null,
    "leaving preorder ends the cycle even though stock never moved",
  );

  const back = await observeVariantAvailabilityCycles(
    prisma,
    soldOutOnPreorder(variant.id),
    new Date("2026-09-21T03:00:00.000Z"),
  );
  assert.equal(back.get(variant.id), "2026-10-06");
});

test("I9 concurrent observations of the same sell-out produce one cycle, not two", async () => {
  // Two syncs overlapping is the ordinary case, not an exotic one. Whichever commits first defines
  // the cycle; the other must adopt it rather than write a competing date.
  const variant = await seedVariant("race");

  const results = await Promise.allSettled(
    ["2026-09-18T03:00:00.000Z", "2026-09-18T04:00:00.000Z", "2026-09-18T05:00:00.000Z"].map((at) =>
      observeVariantAvailabilityCycles(prisma, soldOutOnPreorder(variant.id), new Date(at)),
    ),
  );
  // A lost upsert race surfaces as a rejected promise, never as a second row.
  assert.ok(
    results.some((result) => result.status === "fulfilled"),
    "at least one observer must succeed",
  );

  const rows = await prisma.variantAvailabilityCycle.findMany({ where: { variantId: variant.id } });
  assert.equal(rows.length, 1, "the variant key admits exactly one cycle");
  // All three observers saw the same Vietnamese day, so whoever won, the date is the same fact.
  assert.equal(rows[0]!.availabilityDate?.toISOString(), "2026-10-03T00:00:00.000Z");
});

test("I9 a variant that has never been on preorder stores no row at all", async () => {
  // Every standard variant in the catalog passes through this observer on every sync. Writing a row
  // for each would make the table as large as the catalog to say nothing.
  const variant = await seedVariant("standard");

  const dates = await observeVariantAvailabilityCycles(
    prisma,
    [{ variantId: variant.id, stockNonPositive: true, isPreorder: false }],
    syncedAt,
  );

  assert.equal(dates.get(variant.id), null);
  assert.equal(await prisma.variantAvailabilityCycle.count({ where: { variantId: variant.id } }), 0);
});

test("I9 different variants carry their own independent dates", async () => {
  const early = await seedVariant("early");
  const late = await seedVariant("late");

  await observeVariantAvailabilityCycles(prisma, soldOutOnPreorder(early.id), syncedAt);
  await observeVariantAvailabilityCycles(
    prisma,
    soldOutOnPreorder(late.id),
    new Date("2026-09-25T03:00:00.000Z"),
  );

  const dates = await readVariantAvailabilityDates(prisma, [early.id, late.id]);
  assert.equal(dates.get(early.id), "2026-10-03");
  assert.equal(dates.get(late.id), "2026-10-10");
});

test("I9 the database refuses a half-open cycle", async () => {
  // The paired-dates CHECK. A row with a start and no promise, or a promise with no start, is a
  // state no consumer knows how to read, so it must not be representable.
  const variant = await seedVariant("halfopen");
  await assert.rejects(
    prisma.variantAvailabilityCycle.create({
      data: {
        variantId: variant.id,
        cycleStartDate: new Date(Date.UTC(2026, 8, 18)),
        availabilityDate: null,
        lastStockNonPositive: true,
        lastPreorder: true,
      },
    }),
    /cycle_dates_paired/,
  );
});
