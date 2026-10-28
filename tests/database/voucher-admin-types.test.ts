import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { MAX_VOUCHER_TYPES_PER_SHOP, createVoucherAdminService, type VoucherAdminResult } from "../../src/commerce/voucher-admin-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/** ADR 0020 D-7: the Admin creates types and their tiers; the service keeps the ladder sound and the distribution with the type. */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_033;
const f = createVoucherFixtures(prisma, SHOP, "vchr-admin-types");
const admin = { user: { id: "voucher-admin-test", role: "ADMIN" }, session: { id: "voucher-session-test" } };
const customer = { user: { id: "voucher-customer-test", role: "CUSTOMER" }, session: { id: "voucher-session-test-2" } };
const service = createVoucherAdminService(prisma, SHOP);
const NOW = new Date("2026-10-25T12:00:00Z");

const typeForm = (overrides: Record<string, unknown> = {}) => ({ name: "Theo đơn hàng", priority: 1, issuance: "AUTO", visibility: "PUBLIC", ...overrides });
const tierForm = (typeId: string, amountVnd: number, min: number, overrides: Record<string, unknown> = {}) => ({
  name: `Mốc ${min}`, typeId, kind: "MERCHANDISE", discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd: min, scope: { mode: "ALL_SHOP", excludeProductIds: [] }, ...overrides,
});

function good(result: VoucherAdminResult) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<VoucherAdminResult, { ok: true }>;
}
function refused(result: VoucherAdminResult, reason: string, issue?: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  const failure = result as Extract<VoucherAdminResult, { ok: false }>;
  assert.equal(failure.reason, reason, JSON.stringify(result));
  if (issue !== undefined) assert.deepEqual(failure.issues?.map((entry) => entry.code), [issue]);
  return failure;
}

/** An Admin who opened the form just now: the current revision travels with it. */
const editType = async (id: string, input: unknown) => service.editType(admin, id, (await service.getType(admin, id))?.revision ?? 1, input, NOW);

async function cleanup() {
  await f.cleanup();
}
test.before(cleanup);
test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("only an ADMIN can create, edit or list types", async () => {
  await assert.rejects(() => service.createType(customer as never, typeForm(), NOW), AuthorizationError);
  await assert.rejects(() => service.editType(customer as never, "x", 1, typeForm(), NOW), AuthorizationError);
  await assert.rejects(() => service.listTypes(customer as never), AuthorizationError);
  await assert.rejects(() => service.createType(null as never, typeForm(), NOW), AuthorizationError);
});

test("a type is created, validated, listed by priority with its tier count, and renamed or moved freely", async () => {
  const b = good(await service.createType(admin, typeForm({ name: "Phần trăm", priority: 2 }), NOW));
  const a = good(await service.createType(admin, typeForm({ name: "Theo đơn hàng", priority: 1 }), NOW));
  refused(await service.createType(admin, typeForm({ name: "" }), NOW), "VALIDATION", "name-invalid");
  refused(await service.createType(admin, typeForm({ priority: 0 }), NOW), "VALIDATION", "type-priority-invalid");
  good(await service.create(admin, tierForm(a.id, 30_000, 500_000), NOW));
  const listed = await service.listTypes(admin);
  assert.deepEqual(listed.map((type) => [type.name, type.priority, type._count.tiers]), [["Theo đơn hàng", 1, 1], ["Phần trăm", 2, 0]]);
  good(await editType(b.id, typeForm({ name: "Giảm %", priority: 9 })));
  assert.deepEqual((await service.getType(admin, b.id))?.priority, 9);
  refused(await service.editType(admin, "missing", 1, typeForm(), NOW), "TYPE_NOT_FOUND");
  assert.equal(await service.getType(admin, "bad id"), null);
});

test("types are bounded per shop and scoped to the shop", async () => {
  for (let index = 0; index < MAX_VOUCHER_TYPES_PER_SHOP; index += 1) good(await service.createType(admin, typeForm({ name: `Loại ${index}`, priority: index + 1 }), NOW));
  refused(await service.createType(admin, typeForm({ name: "Một loại nữa", priority: 50 }), NOW), "TYPE_LIMIT_REACHED");
  const other = createVoucherAdminService(prisma, SHOP + 1);
  assert.deepEqual(await other.listTypes(admin), [], "another shop sees none of them");
  const mine = (await service.listTypes(admin))[0]!;
  refused(await other.editType(admin, mine.id, mine.revision, typeForm(), NOW), "TYPE_NOT_FOUND");
  refused(await other.create(admin, tierForm(mine.id, 30_000, 500_000), NOW), "TYPE_NOT_FOUND");
});

test("a code belongs to one campaign or one type per shop", async () => {
  good(await service.createType(admin, typeForm({ name: "KOL", issuance: "CODE", visibility: "PRIVATE", code: "KOL2026" }), NOW));
  refused(await service.createType(admin, typeForm({ name: "KOL 2", priority: 2, issuance: "CODE", visibility: "PRIVATE", code: "kol2026" }), NOW), "CODE_TAKEN");
  refused(await service.create(admin, { name: "Mã trùng", kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL2026", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 10_000 }, minEligibleSubtotalVnd: 50_000, scope: { mode: "ALL_SHOP", excludeProductIds: [] } }, NOW), "CODE_TAKEN");
  good(await service.create(admin, { name: "Mã riêng", kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "FLYER001", discount: { type: "FIXED_AMOUNT_VND", amountVnd: 10_000 }, minEligibleSubtotalVnd: 50_000, scope: { mode: "ALL_SHOP", excludeProductIds: [] } }, NOW));
  refused(await service.createType(admin, typeForm({ name: "Trùng mã voucher", priority: 3, issuance: "CODE", visibility: "PRIVATE", code: "FLYER001" }), NOW), "CODE_TAKEN");
});

test("a tier takes its distribution and code from its type, whatever the form says, and keeps its code empty", async () => {
  const type = good(await service.createType(admin, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "LADDER9" }), NOW));
  const tier = good(await service.create(admin, tierForm(type.id, 30_000, 500_000, { issuance: "AUTO", visibility: "PUBLIC", code: null }), NOW));
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: tier.id } });
  assert.deepEqual([row.typeId, row.issuance, row.visibility, row.code, row.isEnabled], [type.id, "CODE", "PRIVATE", null, false]);
  assert.deepEqual((await service.get(admin, tier.id))?.type?.id, type.id);
  refused(await service.create(admin, tierForm("missing-type", 30_000, 500_000), NOW), "TYPE_NOT_FOUND");
  refused(await service.create(admin, tierForm(type.id, 30_000, 500_000, { kind: "SHIPPING_FREE", discount: undefined }), NOW), "VALIDATION", "type-not-allowed");
});

test("ladder rule applies when a tier would be live next to another: draft tiers are free, enabling a conflicting one is refused", async () => {
  const type = good(await service.createType(admin, typeForm(), NOW));
  const a500 = good(await service.create(admin, tierForm(type.id, 30_000, 500_000), NOW));
  const a1m = good(await service.create(admin, tierForm(type.id, 80_000, 1_000_000), NOW));
  const dup = good(await service.create(admin, tierForm(type.id, 40_000, 500_000), NOW));
  const worse = good(await service.create(admin, tierForm(type.id, 80_000, 2_000_000), NOW));
  good(await service.setEnabled(admin, a500.id, a500.revision, true, NOW));
  good(await service.setEnabled(admin, a1m.id, a1m.revision, true, NOW));
  refused(await service.setEnabled(admin, dup.id, dup.revision, true, NOW), "VALIDATION", "ladder-conflict");
  refused(await service.setEnabled(admin, worse.id, worse.revision, true, NOW), "VALIDATION", "ladder-conflict");
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: dup.id } })).isEnabled, false);
  // Fix the draft and it goes live: a higher threshold that gives more.
  good(await service.edit(admin, worse.id, worse.revision, tierForm(type.id, 200_000, 2_000_000), NOW));
  const fixed = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: worse.id } });
  good(await service.setEnabled(admin, fixed.id, fixed.revision, true, NOW));
  // Editing a LIVE tier into a conflict is refused too; a tier of another scope or another type is not compared.
  refused(await service.edit(admin, a1m.id, (await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: a1m.id } })).revision, tierForm(type.id, 30_000, 1_000_000), NOW), "VALIDATION", "ladder-conflict");
  const other = good(await service.createType(admin, typeForm({ name: "Khác", priority: 2 }), NOW));
  const sameAsA500 = good(await service.create(admin, tierForm(other.id, 30_000, 500_000), NOW));
  good(await service.setEnabled(admin, sameAsA500.id, sameAsA500.revision, true, NOW));
});

test("an ended tier no longer blocks the ladder", async () => {
  const type = good(await service.createType(admin, typeForm(), NOW));
  const old = good(await service.create(admin, tierForm(type.id, 30_000, 500_000, { startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: new Date("2026-10-01T00:00:00Z") }), NOW));
  await prisma.voucherCampaign.update({ where: { id: old.id }, data: { isEnabled: true, enabledAt: new Date("2026-09-01T00:00:00Z") } });
  const fresh = good(await service.create(admin, tierForm(type.id, 20_000, 500_000), NOW));
  good(await service.setEnabled(admin, fresh.id, fresh.revision, true, NOW));
});

test("a copy of a tier stays in its type and, for a CODE type, takes the type's code; it is a disabled draft", async () => {
  const type = good(await service.createType(admin, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "COPYLAD1" }), NOW));
  const tier = good(await service.create(admin, tierForm(type.id, 30_000, 500_000), NOW));
  const copy = good(await service.copy(admin, tier.id, {}, NOW));
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: copy.id } });
  assert.deepEqual([row.typeId, row.code, row.isEnabled, row.issuance], [type.id, null, false, "CODE"]);
});

test("a type keeps its distribution once it has tiers; its code is free until a tier has been enabled", async () => {
  const type = good(await service.createType(admin, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "FIRSTCODE" }), NOW));
  const tier = good(await service.create(admin, tierForm(type.id, 30_000, 500_000), NOW));
  // Code only, nothing live yet: allowed. Distribution: locked.
  good(await editType(type.id, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "SECONDCODE" })));
  refused(await editType(type.id, typeForm({ issuance: "AUTO", visibility: "PUBLIC" })), "IDENTITY_LOCKED");
  refused(await editType(type.id, typeForm({ issuance: "CODE", visibility: "PUBLIC", code: "SECONDCODE" })), "IDENTITY_LOCKED");
  // Once a tier has been enabled the code is part of its identity.
  good(await service.setEnabled(admin, tier.id, tier.revision, true, NOW));
  refused(await editType(type.id, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "THIRDCODE" })), "IDENTITY_LOCKED");
  good(await editType(type.id, typeForm({ name: "Đổi tên", priority: 4, issuance: "CODE", visibility: "PRIVATE", code: "SECONDCODE" })));
  // A type with no tiers can still change everything.
  const empty = good(await service.createType(admin, typeForm({ name: "Trống", priority: 2 }), NOW));
  good(await editType(empty.id, typeForm({ name: "Trống", priority: 2, issuance: "CODE", visibility: "PUBLIC", code: "EMPTYONE" })));
});

test("editing a tier ignores the form's distribution and type; an enabled tier's economics can change, its type cannot", async () => {
  const type = good(await service.createType(admin, typeForm({ issuance: "CODE", visibility: "PRIVATE", code: "EDITLAD1" }), NOW));
  const other = good(await service.createType(admin, typeForm({ name: "Khác", priority: 2 }), NOW));
  const tier = good(await service.create(admin, tierForm(type.id, 30_000, 500_000), NOW));
  good(await service.setEnabled(admin, tier.id, tier.revision, true, NOW));
  const live = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: tier.id } });
  const edited = good(await service.edit(admin, tier.id, live.revision, tierForm(other.id, 35_000, 520_000, { issuance: "AUTO", visibility: "PUBLIC", code: "WRONG" }), NOW));
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: tier.id } });
  assert.deepEqual([row.typeId, row.issuance, row.visibility, row.code, row.fixedAmountVnd, row.revision], [type.id, "CODE", "PRIVATE", null, BigInt(35_000), edited.revision]);
});

test("a capped percentage rung that would save less than the rung below it is refused when enabled (review of #222)", async () => {
  const type = good(await service.createType(admin, typeForm({ name: "Phần trăm", priority: 3 }), NOW));
  const percentTier = (percent: number, cap: number | null, min: number) => ({
    name: `${percent}% từ ${min}`, typeId: type.id, kind: "MERCHANDISE", discount: { type: "PERCENTAGE", percent, maxDiscountVnd: cap }, minEligibleSubtotalVnd: min, scope: { mode: "ALL_SHOP", excludeProductIds: [] },
  });
  const low = good(await service.create(admin, percentTier(5, 50_000, 500_000), NOW));
  const high = good(await service.create(admin, percentTier(10, 10_000, 1_000_000), NOW));
  good(await service.setEnabled(admin, low.id, low.revision, true, NOW));
  refused(await service.setEnabled(admin, high.id, high.revision, true, NOW), "VALIDATION", "ladder-conflict");
  // Raising its cap to at least the lower rung's makes it a real rung.
  good(await service.edit(admin, high.id, high.revision, percentTier(10, 100_000, 1_000_000), NOW));
  const fixed = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: high.id } });
  good(await service.setEnabled(admin, fixed.id, fixed.revision, true, NOW));
});

test("a stale type form is refused: the second tab cannot write its old values over the first tab's save (review of #222)", async () => {
  const type = good(await service.createType(admin, typeForm({ name: "Gốc", priority: 2 }), NOW));
  const tabA = (await service.getType(admin, type.id))!;
  const tabB = (await service.getType(admin, type.id))!;
  assert.equal(tabA.revision, 1);
  const saved = good(await service.editType(admin, type.id, tabA.revision, typeForm({ name: "Gốc", priority: 5 }), NOW));
  assert.equal(saved.revision, 2);
  // Tab B still holds revision 1 and only meant to rename: it must not bring priority 2 back.
  refused(await service.editType(admin, type.id, tabB.revision, typeForm({ name: "Đổi tên", priority: 2 }), NOW), "STALE_REVISION");
  assert.deepEqual([(await service.getType(admin, type.id))!.name, (await service.getType(admin, type.id))!.priority], ["Gốc", 5]);
  // A refused revision, a missing one, and a malformed one all refuse without writing.
  for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_647]) refused(await service.editType(admin, type.id, bad, typeForm({ priority: 9 }), NOW), "STALE_REVISION");
  assert.equal((await service.getType(admin, type.id))!.priority, 5);
  // Reopened at the current revision it saves, and each save moves the revision on.
  const again = good(await editType(type.id, typeForm({ name: "Đổi tên", priority: 5 })));
  assert.equal(again.revision, 3);
});

test("the stacking order of a type cannot change while a shopper holds one of its vouchers; renaming can (review of #222)", async () => {
  const type = good(await service.createType(admin, typeForm({ name: "Có hold", priority: 2 }), NOW));
  const tier = good(await service.create(admin, tierForm(type.id, 30_000, 500_000), NOW));
  good(await service.setEnabled(admin, tier.id, tier.revision, true, NOW));
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: tier.id } });
  const hold = await f.hold(row.id, { attemptKey: f.hex("live-attempt") });
  await prisma.voucherCampaign.update({ where: { id: row.id }, data: { reservedUses: 1, reservedVnd: BigInt(30_000) } });
  // In flight: the order is frozen, the name and an unchanged priority are not.
  refused(await editType(type.id, typeForm({ name: "Có hold", priority: 1 })), "HOLDS_LIVE");
  good(await editType(type.id, typeForm({ name: "Đã đổi tên", priority: 2 })));
  assert.equal((await service.getType(admin, type.id))!.priority, 2);
  // Once the hold is released (or has expired) the order can move.
  await prisma.voucherHold.update({ where: { id: hold.id }, data: { state: "RELEASED", releasedAt: new Date() } });
  good(await editType(type.id, typeForm({ name: "Đã đổi tên", priority: 1 })));
  assert.equal((await service.getType(admin, type.id))!.priority, 1);
  // A hold of ANOTHER type never blocks this one.
  const other = good(await service.createType(admin, typeForm({ name: "Khác", priority: 4 }), NOW));
  const otherTier = good(await service.create(admin, tierForm(other.id, 30_000, 500_000), NOW));
  await f.hold(otherTier.id, { attemptKey: f.hex("other-attempt") });
  good(await editType(type.id, typeForm({ name: "Đã đổi tên", priority: 3 })));
  refused(await editType(other.id, typeForm({ name: "Khác", priority: 6 })), "HOLDS_LIVE");
});
