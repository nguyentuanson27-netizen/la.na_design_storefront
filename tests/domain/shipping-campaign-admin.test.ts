import assert from "node:assert/strict";
import test from "node:test";
import { createShippingCampaignAdminService } from "../../src/commerce/shipping-campaign-admin.ts";
import { parseShippingCampaignForm, parseShippingCampaignIdentity } from "../../src/commerce/shipping-campaign-admin-input.ts";
import { AuthorizationError } from "../../src/auth/authorization.ts";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { ShippingCampaignRow } from "../../src/commerce/shipping-campaign-repository.ts";

const now = new Date("2026-10-20T12:00:00Z");
const admin = { user: { id: "admin", role: "ADMIN" }, session: { id: "session" } };
const values = { name: "Two paid units", minimumQuantity: 2, priority: 0, startsAt: null, endsAt: null, stackingEnabled: false, scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: ["aoDai", "setDo"], includeProductIds: [], excludeProductIds: [] } };
function fixture() {
  let row: ShippingCampaignRow | null = null;
  const writes: string[] = [];
  let enabledCount = 0;
  const tx = {
    $executeRaw: async () => 0,
    productMirror: { findMany: async () => [] },
    shippingPromotionCampaign: {
      create: async ({ data }: { data: Partial<ShippingCampaignRow> }) => { writes.push("create"); row = { id: "shipping", revision: 1, enabledAt: null, disabledAt: null, ...data } as ShippingCampaignRow; return { id: row.id }; },
      findFirst: async ({ where }: { where: { pancakeShopId: number; id: string } }) => row?.pancakeShopId === where.pancakeShopId && row.id === where.id ? { ...row } : null,
      updateMany: async ({ where, data }: { where: { revision: number }; data: Record<string, unknown> }) => {
        if (!row || row.revision !== where.revision) return { count: 0 };
        writes.push("update"); const revision = row.revision + 1; row = { ...row, ...data, revision } as ShippingCampaignRow; return { count: 1 };
      },
      count: async () => enabledCount,
    },
  };
  const client = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(tx) } as unknown as PrismaClient;
  return { client, writes, get row() { return row; }, setCount(value: number) { enabledCount = value; }, service: createShippingCampaignAdminService(client, 123) };
}

test("admin mutations authorize before any database operation", async () => {
  const f = fixture();
  for (const session of [null, { ...admin, user: { ...admin.user, role: "CUSTOMER" } }]) {
    await assert.rejects(f.service.create(session, values, now), AuthorizationError);
    await assert.rejects(f.service.edit(session, "shipping", 1, values, now), AuthorizationError);
    await assert.rejects(f.service.setEnabled(session, "shipping", 1, true, now), AuthorizationError);
  }
  assert.deepEqual(f.writes, []);
});
test("saving creates a disabled campaign; enabling and threshold edits are revision checked", async () => {
  const f = fixture();
  assert.equal((await f.service.create(admin, values, now)).ok, true);
  assert.equal(f.row?.isEnabled, false);
  assert.equal((await f.service.setEnabled(admin, "shipping", 1, true, now)).ok, true);
  assert.equal(f.row?.isEnabled, true);
  assert.equal((await f.service.edit(admin, "shipping", 2, { ...values, minimumQuantity: 3 }, now)).ok, true);
  assert.equal(f.row?.minimumQuantity, 3);
  assert.equal(f.row?.revision, 3);
  assert.deepEqual(await f.service.edit(admin, "shipping", 2, values, now), { ok: false, reason: "STALE_REVISION" });
  assert.equal(f.row?.minimumQuantity, 3);
  assert.equal((await f.service.setEnabled(admin, "shipping", 3, false, now)).ok, true);
  assert.equal(f.row?.isEnabled, false);
});
test("cross-shop campaigns and foreign/unknown products cannot be edited or enabled", async () => {
  const f = fixture();
  await f.service.create(admin, values, now);
  const other = createShippingCampaignAdminService(f.client, 124);
  assert.deepEqual(await other.setEnabled(admin, "shipping", 1, true, now), { ok: false, reason: "NOT_FOUND" });
  assert.deepEqual(await f.service.edit(admin, "shipping", 1, { ...values, scope: { ...values.scope, includeProductIds: ["foreign-product"] } }, now), { ok: false, reason: "TARGET_INVALID" });
  assert.equal(f.row?.revision, 1);
});
test("expired rules and a full bounded reader cannot be enabled", async () => {
  const f = fixture();
  await f.service.create(admin, { ...values, endsAt: now }, now);
  assert.deepEqual(await f.service.setEnabled(admin, "shipping", 1, true, now), { ok: false, reason: "WINDOW_ENDED" });
  await f.service.edit(admin, "shipping", 1, values, now);
  f.setCount(50);
  assert.deepEqual(await f.service.setEnabled(admin, "shipping", 2, true, now), { ok: false, reason: "LIMIT_REACHED" });
  assert.equal(f.row?.isEnabled, false);
});
test("form parsing enforces Vietnam time, scalar uniqueness, known scopes and paid thresholds", () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: "Two paid units", minimumQuantity: "2", priority: "0", startsAt: "2026-10-20T19:00", endsAt: "2026-10-21T19:00" })) form.set(key, value);
  form.append("categoryKey", "aoDai");
  const parsed = parseShippingCampaignForm(form);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.startsAt?.toISOString(), now.toISOString());
  assert.equal(parsed.value.stackingEnabled, false);
  form.append("minimumQuantity", "1"); assert.equal(parseShippingCampaignForm(form).ok, false);
  form.set("minimumQuantity", "1e3"); assert.equal(parseShippingCampaignForm(form).ok, false);
  form.set("minimumQuantity", "2"); form.set("categoryKey", "unknown"); assert.equal(parseShippingCampaignForm(form).ok, false);
  form.set("categoryKey", "aoDai"); form.set("startsAt", "2026-02-30T10:00"); assert.equal(parseShippingCampaignForm(form).ok, false);
  form.set("campaignId", "shipping"); form.set("revision", "3"); assert.deepEqual(parseShippingCampaignIdentity(form), { id: "shipping", revision: 3 });
  form.append("revision", "2"); assert.equal(parseShippingCampaignIdentity(form), null);
});
