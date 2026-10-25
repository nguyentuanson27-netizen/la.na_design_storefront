import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherAdminService } from "../../src/commerce/voucher-admin-service.ts";
import { voucherCapFloor } from "../../src/commerce/voucher-campaign.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_004;
const f = createVoucherFixtures(prisma, SHOP, "vchr-cap");
const admin = { user: { id: "voucher-cap-admin", role: "ADMIN" }, session: { id: "voucher-cap-session" } };
const service = createVoucherAdminService(prisma, SHOP);
const NOW = new Date("2026-10-25T12:00:00Z");

const form = (overrides: Record<string, unknown> = {}) => ({
  name: "Cap test",
  kind: "MERCHANDISE",
  issuance: "AUTO",
  visibility: "PUBLIC",
  discount: { type: "FIXED_AMOUNT_VND", amountVnd: 30_000 },
  minEligibleSubtotalVnd: 600_000,
  scope: { mode: "ALL_SHOP", excludeProductIds: [] },
  ...overrides,
});

test.before(f.cleanup);
test.after(async () => {
  await f.cleanup();
  await prisma.$disconnect();
});
test.beforeEach(f.cleanup);

/** A campaign with a committed ledger: 1 use redeemed (100K), 2 uses held (150K). Floor: 3 uses / 250K. */
async function committed() {
  const c = await f.campaign({
    maxUses: 10, maxBudgetVnd: BigInt(1_000_000), redeemedUses: 1, redeemedVnd: BigInt(100_000), reservedUses: 2, reservedVnd: BigInt(150_000),
  });
  return c;
}

test("the floor is redeemed-not-refunded plus live holds", () => {
  assert.deepEqual(voucherCapFloor({ redeemedUses: 1, reservedUses: 2, redeemedVnd: 100_000, reservedVnd: 150_000 }), { uses: 3, vnd: 250_000 });
});

test("AC-44: lowering maxUses or maxBudget under the committed floor is refused with the minimum allowed", async () => {
  const c = await committed();
  const lowerUses = await service.edit(admin, c.id, c.revision, form({ maxUses: 2, maxBudgetVnd: 1_000_000 }), NOW);
  assert.deepEqual(lowerUses, { ok: false, reason: "CAP_BELOW_COMMITTED", floor: { uses: 3, vnd: 250_000 } });
  const lowerBudget = await service.edit(admin, c.id, c.revision, form({ maxUses: 10, maxBudgetVnd: 249_999 }), NOW);
  assert.deepEqual(lowerBudget, { ok: false, reason: "CAP_BELOW_COMMITTED", floor: { uses: 3, vnd: 250_000 } });
  // Nothing changed: the revision, the caps and the holds' budget are as before.
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.revision, c.revision);
  assert.equal(row.maxUses, 10);
});

test("AC-44: a cap equal to the committed floor is allowed, but nothing more can then be granted", async () => {
  const c = await committed();
  const result = await service.edit(admin, c.id, c.revision, form({ maxUses: 3, maxBudgetVnd: 250_000 }), NOW);
  assert.equal(result.ok, true, JSON.stringify(result));
  // The database refuses one more reservation: the committed floor is also its invariant.
  await assert.rejects(
    prisma.voucherCampaign.update({ where: { id: c.id }, data: { reservedUses: { increment: 1 }, reservedVnd: { increment: BigInt(30_000) } } }),
    /check constraint|violates/i,
  );
});

test("unlimited -> limited is checked against the same floor, and limited -> unlimited always works", async () => {
  const c = await f.campaign({ redeemedUses: 4, redeemedVnd: BigInt(120_000) });
  assert.equal((await service.edit(admin, c.id, c.revision, form({ maxUses: 3 }), NOW)).ok, false);
  assert.equal((await service.edit(admin, c.id, c.revision, form({ maxBudgetVnd: 119_999 }), NOW)).ok, false);
  const ok = await service.edit(admin, c.id, c.revision, form({ maxUses: 4, maxBudgetVnd: 120_000 }), NOW);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const open = await service.edit(admin, c.id, (ok as { revision: number }).revision, form({ maxUses: null, maxBudgetVnd: null }), NOW);
  assert.equal(open.ok, true);
});

test("a cap edit never touches a hold: the held amount and expiry are unchanged (no force-revoke)", async () => {
  const c = await committed();
  const held = await f.hold(c.id);
  const result = await service.edit(admin, c.id, c.revision, form({ maxUses: 3, maxBudgetVnd: 250_000 }), NOW);
  assert.equal(result.ok, true);
  const after = await prisma.voucherHold.findUniqueOrThrow({ where: { id: held.id } });
  assert.equal(after.state, "HELD");
  assert.equal(after.expiresAt.getTime(), held.expiresAt.getTime());
  assert.equal(after.campaignRevision, held.campaignRevision);
});

test("disable stops new grants but leaves live holds and the ledger exactly as they were (AC-41)", async () => {
  const c = await f.campaign({ maxUses: 5, reservedUses: 1, reservedVnd: BigInt(30_000) });
  const held = await f.hold(c.id);
  const off = await service.setEnabled(admin, c.id, c.revision, false, new Date(NOW.getTime() + 1_000));
  assert.equal(off.ok, true, JSON.stringify(off));
  const holdAfter = await prisma.voucherHold.findUniqueOrThrow({ where: { id: held.id } });
  const rowAfter = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(holdAfter.state, "HELD");
  assert.deepEqual([rowAfter.reservedUses, Number(rowAfter.reservedVnd)], [1, 30_000]);
  assert.equal(rowAfter.isEnabled, false);
});

test("two simultaneous cap edits and a ledger bump serialize under the campaign row lock", async () => {
  const c = await committed();
  // Both edits want a cap at the floor; whichever runs first wins on revision, the other sees a stale revision.
  const [a, b] = await Promise.all([
    service.edit(admin, c.id, c.revision, form({ maxUses: 3, maxBudgetVnd: 250_000 }), NOW),
    service.edit(admin, c.id, c.revision, form({ maxUses: 4, maxBudgetVnd: 260_000 }), NOW),
  ]);
  const reasons = [a, b].map((r) => (r.ok ? "ok" : (r as { reason: string }).reason)).sort();
  assert.deepEqual(reasons, ["STALE_REVISION", "ok"]);
});
