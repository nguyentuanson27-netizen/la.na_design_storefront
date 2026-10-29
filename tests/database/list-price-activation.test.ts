import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import {
  createDraftPromotionCampaign,
  copyPromotionCampaign,
  editDraftPromotionCampaign,
  editScheduledPromotionCampaign,
  publishPromotionCampaign,
  disablePromotionCampaign,
  endPromotionCampaignEarly,
  lockRevision,
} from "../../src/commerce/promotion-activation-service.ts";
import {
  freezeListPriceCampaignMutations,
  preflightListPriceRollback,
  releaseListPriceCampaignFreeze,
} from "../../src/commerce/list-price-rollback.ts";
import { previewListPriceCampaign } from "../../src/commerce/list-price-campaign-preview.ts";
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const peer = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const admin = {
  user: { id: "list-price-test-admin", role: "ADMIN" },
  session: { id: "test-session" },
};
const now = new Date("2026-10-30T00:00:00Z"),
  env = { LA_PROMOTION_ACTIVATION_ENABLED: "true" };
const prefix = "list-price-activation-";
let productId: string;
async function cleanup() {
  await db.promotionCampaign.deleteMany({
    where: { name: { startsWith: prefix } },
  });
  await db.productMirror.deleteMany({ where: { pancakeProductId: prefix } });
  await db.promotionPricingRevision.update({
    where: { id: "current" },
    data: { campaignMutationFrozen: false, campaignRollbackId: null },
  });
}
test.before(async () => {
  process.env.LIST_PRICE_DISPLAY = "true";
  process.env.LIST_PRICE_CAMPAIGN_BASIS = "true";
  await cleanup();
});
test.after(async () => {
  await cleanup();
  delete process.env.LIST_PRICE_DISPLAY;
  delete process.env.LIST_PRICE_CAMPAIGN_BASIS;
  await Promise.all([db.$disconnect(), peer.$disconnect()]);
});
test.beforeEach(async () => {
  await cleanup();
  const product = await db.productMirror.create({
    data: {
      pancakeShopId: 925225,
      pancakeProductId: prefix,
      slug: prefix,
      name: prefix,
      syncedAt: now,
      variants: {
        create: [565000, 590000].map((price, i) => ({
          pancakeVariationId: prefix + i,
          size: "M" + i,
          pancakeRetailPrice: price,
          syncedAt: now,
        })),
      },
    },
  });
  productId = product.id;
});
async function draft(percent = 20) {
  const result = await createDraftPromotionCampaign({
    name: prefix + percent,
    percentageValue: percent,
    targets: [{ productId, variantId: null }],
    session: admin,
    client: db,
  });
  assert.ok(result.ok);
  return result.campaignId;
}
async function publish(id: string, client = db) {
  return publishPromotionCampaign({
    campaignId: id,
    now,
    session: admin,
    client,
    env,
  });
}
const freeze = (client = db) =>
  freezeListPriceCampaignMutations({
    client,
    session: admin,
    rollbackId: "rollback-test",
    now,
  });
const preflight = () =>
  preflightListPriceRollback({
    client: db,
    session: admin,
    rollbackId: "rollback-test",
    now,
    allInstancesVerified: true,
    env: { LA_PROMOTION_ACTIVATION_ENABLED: "false" },
  });

test("partial thresholds publish with warnings; unsafe math is blocking and no-effective stays blocking", async () => {
  const id = await draft();
  const preview = await previewListPriceCampaign({
    client: db,
    session: admin,
    campaignId: id,
  });
  assert.equal(preview.warningSummary?.count, 1);
  assert.equal(preview.warningSummary?.minimumPercent, 22);
  await assert.rejects(
    previewListPriceCampaign({ client: db, session: null, campaignId: id }),
  );
  const result = await publish(id);
  assert.ok(result.ok);
  assert.equal(result.warnings?.length, 1);
  assert.equal(result.warnings?.[0]?.minimumPercent, 22);
  await disablePromotionCampaign({
    campaignId: id,
    now,
    session: admin,
    client: db,
  });
  const none = await publish(await draft(10));
  assert.ok(!none.ok);
  assert.equal(none.failure.reason, "NO_EFFECTIVE_DISCOUNT");
  const tinyVariant = await db.variantMirror.findFirstOrThrow({
    where: { productId, pancakeRetailPrice: 590000 },
  });
  await db.variantMirror.update({
    where: { id: tinyVariant.id },
    data: { pancakeRetailPrice: 1 },
  });
  const tiny = await publish(await draft(20));
  assert.ok(tiny.ok);
  assert.equal(tiny.warningSummary?.count, 1);
  assert.equal(tiny.warningSummary?.minimumPercent, null);
  await disablePromotionCampaign({
    campaignId: tiny.campaignId,
    now,
    session: admin,
    client: db,
  });
  await db.variantMirror.updateMany({
    where: { productId },
    data: { pancakeRetailPrice: 10000 },
  });
  const zero = await publish(await draft(99));
  assert.ok(!zero.ok);
  assert.equal(zero.failure.reason, "PROMOTION_PRICE_UNSAFE");
  await db.variantMirror.updateMany({
    where: { productId },
    data: { pancakeRetailPrice: Number.MAX_SAFE_INTEGER },
  });
  const overflow = await publish(await draft(25));
  assert.ok(!overflow.ok);
  assert.equal(overflow.failure.reason, "PROMOTION_PRICE_UNSAFE");
  await db.variantMirror.updateMany({
    where: { productId },
    data: { pancakeRetailPrice: null },
  });
  const invalid = await publish(await draft(30));
  assert.ok(!invalid.ok);
  assert.equal(invalid.failure.reason, "UNUSABLE_BASE_PRICE");
});

test("freeze blocks all draft/effective mutation paths but permits disable; preflight refuses enabled percentages", async () => {
  const id = await draft(25),
    draftId = await draft(30);
  assert.ok((await publish(id)).ok);
  await freeze();
  assert.equal((await preflight()).ok, false);
  const revision = (
    await db.promotionPricingRevision.findUniqueOrThrow({
      where: { id: "current" },
    })
  ).revision;
  const results = await Promise.all([
    createDraftPromotionCampaign({
      name: prefix + "blocked",
      session: admin,
      client: db,
    }),
    copyPromotionCampaign({ campaignId: id, session: admin, client: db }),
    editDraftPromotionCampaign({
      campaignId: draftId,
      now,
      session: admin,
      client: db,
      patch: { name: prefix + "edit" },
    }),
    editScheduledPromotionCampaign({
      campaignId: id,
      now,
      session: admin,
      client: db,
      env,
      patch: { percentageValue: 30 },
    }),
    publish(draftId),
  ]);
  for (const result of results) {
    assert.ok(!result.ok);
    assert.equal(result.failure.reason, "ACTIVATION_DISABLED");
  }
  assert.equal(
    (
      await db.promotionPricingRevision.findUniqueOrThrow({
        where: { id: "current" },
      })
    ).revision,
    revision,
  );
  assert.ok(
    (
      await disablePromotionCampaign({
        campaignId: id,
        now,
        session: admin,
        client: db,
      })
    ).ok,
  );
  assert.equal((await preflight()).ok, true);
  assert.ok(!(await publish(draftId)).ok); // cannot slip in between preflight and basis OFF
  await assert.rejects(
    releaseListPriceCampaignFreeze({
      client: db,
      session: admin,
      rollbackId: "rollback-test",
      now,
      allInstancesVerified: false,
    }),
  );
  await releaseListPriceCampaignFreeze({
    client: db,
    session: admin,
    rollbackId: "rollback-test",
    now,
    allInstancesVerified: true,
    env: {
      ...process.env,
      LIST_PRICE_CAMPAIGN_BASIS: "false",
      LA_PROMOTION_ACTIVATION_ENABLED: "false",
    },
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function controlled(
  client: PrismaClient,
  acquired: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
) {
  return new Proxy(client, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (fn: Parameters<PrismaClient["$transaction"]>[0]) =>
        target.$transaction(async (tx) => {
          await lockRevision(tx);
          acquired.resolve();
          await release.promise;
          return (fn as (transaction: typeof tx) => Promise<unknown>)(tx);
        });
    },
  });
}
for (const first of ["publish", "freeze"] as const)
  test(`real concurrent transactions serialize when ${first} owns revision first`, async () => {
    const id = await draft(25),
      acquired = deferred<void>(),
      release = deferred<void>();
    const gated = controlled(db, acquired, release);
    const firstResult =
      first === "publish" ? publish(id, gated) : freeze(gated);
    await acquired.promise;
    let finished = false;
    const secondResult = (
      first === "publish" ? freeze(peer) : publish(id, peer)
    ).then((value) => {
      finished = true;
      return value;
    });
    // Observe the actual database wait, not just an unresolved application Promise.
    for (let i = 0; i < 100; i++) {
      const [row] = await db.$queryRaw<
        Array<{ blocked: boolean }>
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS blocked`;
      if (row?.blocked) break;
      await new Promise((r) => setTimeout(r, 10));
      if (i === 99)
        assert.fail("competing transaction did not wait on the DB lock");
    }
    assert.equal(finished, false);
    release.resolve();
    const [a, b] = await Promise.all([firstResult, secondResult]);
    if (first === "publish") {
      assert.ok("ok" in a && a.ok);
      assert.ok("campaigns" in b && b.campaigns.some((c) => c.id === id));
    } else {
      assert.ok("ok" in b && !b.ok);
      assert.equal(
        (await db.promotionCampaign.findUniqueOrThrow({ where: { id } }))
          .isEnabled,
        false,
      );
    }
  });

test("scheduled edits are fenced, early-end remains available and release requires fresh preflight", async () => {
  const id = await draft(25);
  await db.promotionCampaign.update({
    where: { id },
    data: { startsAt: new Date(now.getTime() + 3600000) },
  });
  assert.ok((await publish(id)).ok);
  await freeze();
  const scheduled = await editScheduledPromotionCampaign({
    campaignId: id,
    now,
    session: admin,
    client: db,
    env,
    patch: { percentageValue: 30 },
  });
  assert.ok(!scheduled.ok);
  assert.equal(scheduled.failure.reason, "ACTIVATION_DISABLED");
  assert.equal((await preflight()).ok, false); // future schedules are included
  assert.ok(
    (
      await disablePromotionCampaign({
        campaignId: id,
        now,
        session: admin,
        client: db,
      })
    ).ok,
  );
  const release = () =>
    releaseListPriceCampaignFreeze({
      client: db,
      session: admin,
      rollbackId: "rollback-test",
      now,
      allInstancesVerified: true,
      env: {
        ...process.env,
        LIST_PRICE_CAMPAIGN_BASIS: "false",
        LA_PROMOTION_ACTIVATION_ENABLED: "false",
      },
    });
  await assert.rejects(release(), /Fresh rollback preflight/);
  assert.equal((await preflight()).ok, true);
  await db.promotionPricingRevision.update({
    where: { id: "current" },
    data: { revision: { increment: BigInt(1) } },
  });
  await assert.rejects(release(), /Fresh rollback preflight/);
  assert.equal((await preflight()).ok, true);
  await release();
  const active = await draft(25);
  assert.ok((await publish(active)).ok);
  await freeze();
  assert.ok(
    (
      await endPromotionCampaignEarly({
        campaignId: active,
        now,
        session: admin,
        client: db,
      })
    ).ok,
  );
  assert.equal((await preflight()).ok, true);
});
