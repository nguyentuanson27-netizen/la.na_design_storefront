import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { MAX_ENABLED_VOUCHERS_PER_SHOP, createVoucherAdminService, type VoucherAdminResult } from "../../src/commerce/voucher-admin-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_003;
const f = createVoucherFixtures(prisma, SHOP, "vchr-admin");
const admin = { user: { id: "voucher-admin-test", role: "ADMIN" }, session: { id: "voucher-session-test" } };
const customer = { user: { id: "voucher-customer-test", role: "CUSTOMER" }, session: { id: "voucher-session-test-2" } };
const service = createVoucherAdminService(prisma, SHOP);
const NOW = new Date("2026-10-25T12:00:00Z");
let productIds: string[] = [];

const form = (overrides: Record<string, unknown> = {}) => ({
  name: "Giảm 30K đơn 600K",
  kind: "MERCHANDISE",
  issuance: "AUTO",
  visibility: "PUBLIC",
  discount: { type: "FIXED_AMOUNT_VND", amountVnd: 30_000 },
  minEligibleSubtotalVnd: 600_000,
  scope: { mode: "ALL_SHOP", excludeProductIds: [] },
  ...overrides,
});
const code = (value: string, extra: Record<string, unknown> = {}) => form({ issuance: "CODE", code: value, ...extra });

function good(result: VoucherAdminResult) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<VoucherAdminResult, { ok: true }>;
}
function refused(result: VoucherAdminResult, reason: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { reason: string }).reason, reason, JSON.stringify(result));
  return result as Extract<VoucherAdminResult, { ok: false }>;
}

async function cleanup() {
  await f.cleanup();
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: "vchr-admin-" } } });
}

test.before(async () => {
  await cleanup();
  const syncedAt = new Date("2026-10-01T00:00:00Z");
  const mine = await prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: "vchr-admin-mine", slug: "vchr-admin-mine", name: "Mine", isActive: true, isPresent: true, syncedAt } });
  const other = await prisma.productMirror.create({ data: { pancakeShopId: SHOP + 1, pancakeProductId: "vchr-admin-other", slug: "vchr-admin-other", name: "Other shop", isActive: true, isPresent: true, syncedAt } });
  productIds = [mine.id, other.id];
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(f.cleanup);

test("create: an inactive draft at revision 1 with an empty ledger; it never activates itself", async () => {
  const { id, revision } = good(await service.create(admin, form(), NOW));
  assert.equal(revision, 1);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id } });
  assert.equal(row.isEnabled, false);
  assert.equal(row.enabledAt, null);
  assert.deepEqual([row.redeemedUses, row.reservedUses, Number(row.redeemedVnd), Number(row.reservedVnd)], [0, 0, 0, 0]);
  assert.equal(row.pancakeShopId, SHOP);
});

test("RBAC: only an ADMIN session can read or write, and every entry re-checks", async () => {
  await assert.rejects(service.create(customer, form(), NOW), AuthorizationError);
  await assert.rejects(service.create(null, form(), NOW), AuthorizationError);
  await assert.rejects(service.list(customer), AuthorizationError);
  await assert.rejects(service.get(undefined, "x"), AuthorizationError);
  const { id } = good(await service.create(admin, form(), NOW));
  await assert.rejects(service.setEnabled(customer, id, 1, true, NOW), AuthorizationError);
  await assert.rejects(service.edit(customer, id, 1, form(), NOW), AuthorizationError);
  await assert.rejects(service.copy(customer, id, {}, NOW), AuthorizationError);
});

test("AC-25: another shop's service cannot see, edit, enable or copy this shop's campaign", async () => {
  const { id } = good(await service.create(admin, form(), NOW));
  const outsider = createVoucherAdminService(prisma, SHOP + 1);
  assert.equal(await outsider.get(admin, id), null);
  assert.deepEqual((await outsider.list(admin)).map((row) => row.id), []);
  refused(await outsider.edit(admin, id, 1, form(), NOW), "NOT_FOUND");
  refused(await outsider.setEnabled(admin, id, 1, true, NOW), "NOT_FOUND");
  refused(await outsider.copy(admin, id, {}, NOW), "NOT_FOUND");
});

test("validation failures come back as issues, not exceptions, and nothing is written", async () => {
  const result = refused(await service.create(admin, form({ minEligibleSubtotalVnd: 10_000 }), NOW), "VALIDATION");
  assert.ok(result.issues!.some((issue) => issue.code === "fixed-min-not-above-amount"));
  assert.equal(await prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP } }), 0);
  refused(await service.create(admin, "not an object", NOW), "VALIDATION");
});

test("a code is unique per shop: the second create is CODE_TAKEN, the first is untouched", async () => {
  good(await service.create(admin, code("DUP50"), NOW));
  refused(await service.create(admin, code("dup50"), NOW), "CODE_TAKEN");
  assert.equal(await prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP, code: "DUP50" } }), 1);
});

test("scope targets must be products of this shop", async () => {
  good(await service.create(admin, form({ scope: { mode: "TARGETED", categoryKeys: [], includeProductIds: [productIds[0]], excludeProductIds: [] } }), NOW));
  refused(await service.create(admin, form({ scope: { mode: "TARGETED", categoryKeys: [], includeProductIds: [productIds[1]], excludeProductIds: [] } }), NOW), "TARGET_INVALID");
  refused(await service.create(admin, form({ scope: { mode: "ALL_SHOP", excludeProductIds: ["missing-product"] } }), NOW), "TARGET_INVALID");
});

test("enable / disable: optimistic revision, derived lifecycle, and a stale revision is refused", async () => {
  const created = good(await service.create(admin, form(), NOW));
  refused(await service.setEnabled(admin, created.id, 7, true, NOW), "STALE_REVISION");
  const enabled = good(await service.setEnabled(admin, created.id, created.revision, true, NOW));
  assert.equal(enabled.revision, 2);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(row.isEnabled, true);
  assert.equal(row.enabledAt?.getTime(), NOW.getTime());
  refused(await service.setEnabled(admin, created.id, 2, true, NOW), "ALREADY_IN_STATE");
  const disabled = good(await service.setEnabled(admin, created.id, 2, false, new Date(NOW.getTime() + 60_000)));
  assert.equal(disabled.revision, 3);
  // It ran, so it is history: Copy is the way back, not re-enable.
  refused(await service.setEnabled(admin, created.id, 3, true, new Date(NOW.getTime() + 120_000)), "NOT_RE_ENABLEABLE");
});

test("a campaign disabled before it ever ran can be enabled again; an ended window cannot be enabled", async () => {
  const future = new Date(NOW.getTime() + 86_400_000);
  const a = good(await service.create(admin, form({ startsAt: future }), NOW));
  const on = good(await service.setEnabled(admin, a.id, a.revision, true, NOW));
  const off = good(await service.setEnabled(admin, a.id, on.revision, false, new Date(NOW.getTime() + 1_000)));
  good(await service.setEnabled(admin, a.id, off.revision, true, new Date(NOW.getTime() + 2_000)));
  const ended = good(await service.create(admin, form({ startsAt: new Date(NOW.getTime() - 86_400_000), endsAt: new Date(NOW.getTime() - 1_000) }), NOW));
  refused(await service.setEnabled(admin, ended.id, ended.revision, true, NOW), "WINDOW_ENDED");
});

test("the number of enabled vouchers per shop is bounded", async () => {
  await prisma.voucherCampaign.createMany({
    data: Array.from({ length: MAX_ENABLED_VOUCHERS_PER_SHOP }, (_, i) => ({ ...f.base, name: `full ${i}`, id: `adminfull-${process.pid}-${i}`, updatedAt: NOW })) as never,
  });
  const extra = good(await service.create(admin, form(), NOW));
  refused(await service.setEnabled(admin, extra.id, extra.revision, true, NOW), "LIMIT_REACHED");
});

test("edit bumps the revision and a stale edit is refused; ended and disabled campaigns are read-only", async () => {
  const created = good(await service.create(admin, form(), NOW));
  const edited = good(await service.edit(admin, created.id, 1, form({ name: "Giảm 40K", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 40_000 } }), NOW));
  assert.equal(edited.revision, 2);
  refused(await service.edit(admin, created.id, 1, form(), NOW), "STALE_REVISION");
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(Number(row.fixedAmountVnd), 40_000);

  const on = good(await service.setEnabled(admin, created.id, 2, true, NOW));
  const off = good(await service.setEnabled(admin, created.id, on.revision, false, new Date(NOW.getTime() + 60_000)));
  refused(await service.edit(admin, created.id, off.revision, form(), new Date(NOW.getTime() + 120_000)), "NOT_EDITABLE");
});

test("identity is locked once a campaign has been enabled, but economics can still change (TG-05 A: new holds only)", async () => {
  const created = good(await service.create(admin, code("FLYER10"), NOW));
  const on = good(await service.setEnabled(admin, created.id, created.revision, true, NOW));
  refused(await service.edit(admin, created.id, on.revision, code("OTHER10"), NOW), "IDENTITY_LOCKED");
  refused(await service.edit(admin, created.id, on.revision, form({ kind: "MERCHANDISE", issuance: "AUTO" }), NOW), "IDENTITY_LOCKED");
  const changed = good(await service.edit(admin, created.id, on.revision, code("FLYER10", { discount: { type: "FIXED_AMOUNT_VND", amountVnd: 50_000 } }), NOW));
  assert.equal(changed.revision, on.revision + 1);
});

test("copy makes a new inactive draft with a fresh ledger; a CODE voucher must bring its own new code", async () => {
  const source = good(await service.create(admin, code("COPYSRC1", { maxUses: 5 }), NOW));
  await prisma.voucherCampaign.update({ where: { id: source.id }, data: { redeemedUses: 2 } });
  refused(await service.copy(admin, source.id, {}, NOW), "VALIDATION");
  refused(await service.copy(admin, source.id, { code: "COPYSRC1" }, NOW), "CODE_TAKEN");
  const copy = good(await service.copy(admin, source.id, { code: "COPYSRC2" }, NOW));
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: copy.id } });
  assert.equal(row.isEnabled, false);
  assert.equal(row.redeemedUses, 0);
  assert.equal(row.maxUses, 5);
  assert.match(row.name, /Bản sao/);
  const auto = good(await service.create(admin, form(), NOW));
  assert.equal(good(await service.copy(admin, auto.id, {}, NOW)).ok, true);
});

test("list is shop-scoped, newest first and bounded", async () => {
  for (let i = 0; i < 3; i += 1) good(await service.create(admin, form({ name: `list ${i}` }), NOW));
  const page = await service.list(admin);
  assert.equal(page.length, 3);
  assert.ok(page.every((row, i) => i === 0 || page[i - 1]!.id > row.id));
  await assert.rejects(service.list(admin, "bad id!"), RangeError);
});
