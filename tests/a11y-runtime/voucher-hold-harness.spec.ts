import { writeFileSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { prisma } from "../../src/db/prisma.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * H3-V browser evidence for V12 (AC-42, AC-43, TG-12): the REAL Server Action `holdStorefrontVouchers`, driven from a
 * real browser against a PRODUCTION build (`next build` + `next start`) of a temporary worktree that also contains the
 * test-only route `tests/fixtures/voucher-hold-harness`. Real PostgreSQL; no Pancake call; no mock, no CSRF bypass.
 *
 * Nothing here records a cookie, a proof or a secret. The network log keeps only method, path (no query), a coarse
 * kind and the status; the UI shows the proof's length, never the proof.
 */

const BASE = process.env.HARNESS_BASE_URL ?? "";
const SHOP = Number(process.env.HARNESS_SHOP ?? "940030");
const EVIDENCE_PATH = process.env.HARNESS_EVIDENCE_PATH ?? "";
/** The id of `holdStorefrontVouchers` in the built artifact (server-reference-manifest). The layout also calls read-only cart actions on every page; those are not holds. */
const HOLD_ACTION_ID = process.env.HARNESS_HOLD_ACTION_ID ?? "";
const P = "vhh";
const CART_COOKIE = "la_cart";
const PAST = new Date("2026-10-01T00:00:00.000Z");
const TTL_MS = 10 * 60_000;

const f = createVoucherFixtures(prisma, SHOP, P);
const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: { LA_VOUCHER_ENABLED: "true" } });
const evidence: Record<string, unknown> = {};

type Net = Readonly<{ method: string; path: string; kind: "document" | "rsc-prefetch" | "rsc-nav" | "hold-action" | "other-action" | "other"; status: number }>;
let sequence = 0;

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await f.cleanup();
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "voucher-hold-" } } });
}

test.beforeAll(async () => {
  test.skip(BASE === "", "HARNESS_BASE_URL is set by scripts/voucher-hold-harness.ts");
  await cleanup();
});
test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  if (EVIDENCE_PATH) writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});
test.beforeEach(cleanup);

async function product(price: number, options: { category?: string; variationId?: string } = {}) {
  sequence += 1;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${sequence}`, slug: `${P}-${sequence}`, name: `Harness ${sequence}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: options.variationId ?? `${P}-${sequence}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${sequence}`, quantity: 50, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  if (options.category) await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: options.category } });
  return created.variants[0]!.id;
}
const cart = (items: ReadonlyArray<{ variantId: string; quantity: number }>) =>
  prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) } } });
const fixed = (amountVnd: number, minVnd: number, extra: Record<string, unknown> = {}) =>
  f.campaign({ fixedAmountVnd: BigInt(amountVnd), minEligibleSubtotalVnd: BigInt(minVnd), ...extra });

async function buyer(browser: Browser, cartId: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: CART_COOKIE, value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

/** Only method, path without query, a coarse kind and the status: no header, cookie, query or body is kept. */
function watch(page: Page, sink: Net[]) {
  page.on("response", (response) => {
    void (async () => {
      const request = response.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/_next/image")) return;
      const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
      const kind: Net["kind"] = headers["next-action"] ? (headers["next-action"] === HOLD_ACTION_ID ? "hold-action" : "other-action") : headers["rsc"] ? (headers["next-router-prefetch"] ? "rsc-prefetch" : "rsc-nav") : request.resourceType() === "document" ? "document" : "other";
      sink.push({ method: request.method(), path: url.pathname, kind, status: response.status() });
    })();
  });
}
const count = (sink: Net[], kind: Net["kind"], method?: string) => sink.filter((n) => n.kind === kind && (method === undefined || n.method === method)).length;
const summary = (sink: Net[]) => ({
  documents: count(sink, "document"), rscPrefetch: count(sink, "rsc-prefetch"), rscNavigation: count(sink, "rsc-nav"),
  holdActionPosts: count(sink, "hold-action", "POST"),
  /** The layout's own read-only cart actions (a different action id): they hold nothing. */
  otherServerActionPosts: count(sink, "other-action", "POST"),
  postsThatAreNotServerActions: sink.filter((n) => n.method !== "GET" && n.kind !== "hold-action" && n.kind !== "other-action").length,
});

async function snapshot(campaignIds: string[]) {
  const holds = await prisma.voucherHold.findMany({ where: { campaign: { pancakeShopId: SHOP } }, orderBy: { createdAt: "asc" } });
  const campaigns = await prisma.voucherCampaign.findMany({ where: { id: { in: campaignIds } }, orderBy: { id: "asc" } });
  const label = new Map(campaigns.map((c, i) => [c.id, `campaign${i + 1}`]));
  return {
    holds: holds.map((h) => ({ state: h.state, kind: h.kind, campaign: label.get(h.campaignId) ?? "other", heldVnd: Number(h.heldDiscountVnd), createdAtMs: h.createdAt.getTime(), expiresAtMs: h.expiresAt.getTime() })),
    campaigns: campaigns.map((c) => ({ campaign: label.get(c.id)!, reservedUses: c.reservedUses, reservedVnd: Number(c.reservedVnd), updatedAtMs: c.updatedAt.getTime() })),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function shown(page: Page): Promise<Record<string, unknown>> {
  const output = page.getByTestId("result");
  await expect(output).not.toHaveText("");
  return JSON.parse((await output.textContent()) ?? "{}") as Record<string, unknown>;
}
/** Clicks and waits for the Server Action response to arrive (counted by the sanitized log). */
async function click(page: Page, sink: Net[], testId: "hold" | "hold-ack" | "hold-stale", options: { clickCount?: number } = {}) {
  const before = count(sink, "hold-action", "POST");
  const expected = options.clickCount ?? 1;
  await page.getByTestId(testId).click({ clickCount: expected });
  await expect.poll(() => count(sink, "hold-action", "POST")).toBe(before + expected);
}
/**
 * back, forward, back -- waiting for the URL after each step. These are client-side (history) navigations, so
 * `goBack()` can return before the router has handled the pop; chaining them blindly can leave the page on "other".
 * Starts on the "other" page and ends on the harness page.
 */
async function walkHistory(page: Page) {
  const harness = new RegExp(`/voucher-hold-harness$`);
  const other = new RegExp(`/voucher-hold-harness/other$`);
  await page.goBack();
  await expect(page).toHaveURL(harness);
  await page.goForward();
  await expect(page).toHaveURL(other);
  await page.goBack();
  await expect(page).toHaveURL(harness);
}
const loadHarness = async (page: Page) => {
  await page.goto(`${BASE}/voucher-hold-harness`);
  await expect(page.locator("[data-harness=voucher-hold]")).toBeVisible();
};

test("AC-42: GET, RSC render, prefetch, hover, reload and back/forward never create, renew or release a hold", async ({ browser }) => {
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const context = await buyer(browser, c.id);
  const page = await context.newPage();
  const net: Net[] = [];
  watch(page, net);
  const before = await snapshot([m.id]);

  await loadHarness(page);
  await expect(page.getByTestId("total")).toHaveText("880000");
  await page.getByTestId("link-other").scrollIntoViewIfNeeded();
  await expect.poll(() => count(net, "rsc-prefetch")).toBeGreaterThan(0); // the prefetch really happened (not a vacuous pass)
  await page.getByTestId("link-other").hover();
  await page.getByTestId("hover-target").hover();
  await page.reload();
  await page.getByTestId("link-other").click(); // client-side navigation
  await expect(page.getByTestId("other")).toBeVisible();
  await walkHistory(page);
  await expect(page.locator("[data-harness=voucher-hold]")).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");

  const after = await snapshot([m.id]);
  expect(count(net, "hold-action")).toBe(0); // not one request carried the hold action id
  expect(summary(net).postsThatAreNotServerActions).toBe(0);
  expect(after).toEqual(before); // holds, counters and the campaign row's updatedAt are byte-for-byte unchanged
  expect(after.holds).toHaveLength(0);
  evidence["AC-42"] = { network: summary(net), databaseBefore: before, databaseAfter: after, unchanged: true };
  await context.close();
});

test("AC-43: one click POSTs once and holds once; double-click, a second tab, reload and back/forward keep the same hold and the same expiry", async ({ browser }) => {
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const context = await buyer(browser, c.id);
  const page = await context.newPage();
  const net: Net[] = [];
  watch(page, net);
  await loadHarness(page);
  const before = await snapshot([m.id]);
  expect(before.holds).toHaveLength(0);

  await click(page, net, "hold");
  const first = await shown(page);
  expect(first).toMatchObject({ ok: true, state: "HELD", totalPayableVnd: 880_000 });
  expect(typeof first.proofLength === "number" && first.proofLength > 100).toBe(true);
  const afterOne = await snapshot([m.id]);
  expect(count(net, "hold-action", "POST")).toBe(1);
  expect(afterOne.holds).toHaveLength(1);
  const hold = afterOne.holds[0]!;
  expect(hold).toMatchObject({ state: "HELD", kind: "MERCHANDISE", heldVnd: 50_000 });
  expect(hold.expiresAtMs - hold.createdAtMs).toBe(TTL_MS); // absolute 10 minutes
  expect(first.expiresAtMs).toBe(hold.expiresAtMs); // the UI shows what the server stored
  expect(afterOne.campaigns[0]).toMatchObject({ reservedUses: 1, reservedVnd: 50_000 });

  // Double-click: two more POSTs reach the server, which answers from the same hold.
  await click(page, net, "hold", { clickCount: 2 });
  expect(await snapshot([m.id])).toEqual(afterOne);
  expect(await shown(page)).toMatchObject({ ok: true, state: "HELD", expiresAtMs: hold.expiresAtMs });

  // A second tab of the same buyer.
  const tab = await context.newPage();
  const net2: Net[] = [];
  watch(tab, net2);
  await loadHarness(tab);
  await click(tab, net2, "hold");
  expect(await shown(tab)).toMatchObject({ ok: true, state: "HELD", expiresAtMs: hold.expiresAtMs });
  expect(await snapshot([m.id])).toEqual(afterOne);

  // Navigation never renews it.
  const postsBefore = count(net, "hold-action", "POST");
  await page.reload();
  await page.getByTestId("link-other").click();
  await expect(page.getByTestId("other")).toBeVisible();
  await walkHistory(page);
  await expect(page.locator("[data-harness=voucher-hold]")).toBeVisible();
  expect(count(net, "hold-action", "POST")).toBe(postsBefore);
  expect(await snapshot([m.id])).toEqual(afterOne);

  evidence["AC-43"] = {
    networkTab1: summary(net), networkTab2: summary(net2), databaseBefore: before, databaseAfterFirstClick: afterOne,
    databaseAfterDoubleClickSecondTabAndNavigation: await snapshot([m.id]), ttlMs: hold.expiresAtMs - hold.createdAtMs, holdCount: 1, reservedUses: 1,
  };
  await context.close();
});

test("AC-43 / CSRF: the same POST from another origin is refused by Next and holds nothing; with the real origin it holds (the request was well formed)", async ({ browser }) => {
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const context = await buyer(browser, c.id);
  const page = await context.newPage();
  const actionId = HOLD_ACTION_ID;
  const net: Net[] = [];
  watch(page, net);
  await loadHarness(page);
  const digest = await page.locator("[data-harness=voucher-hold]").getAttribute("data-digest");
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  await click(page, net, "hold-stale"); // a stale digest: harmless, and it tells us the action id
  expect(await shown(page)).toMatchObject({ ok: false, reason: "QUOTE_CHANGED" });
  expect(actionId).toMatch(/^[0-9a-f]{20,}$/);
  expect((await snapshot([m.id])).holds).toHaveLength(0);

  const post = (origin: string) =>
    context.request.post(`${BASE}/voucher-hold-harness`, {
      headers: { "next-action": actionId, origin, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
      data: JSON.stringify([{ expectedQuoteDigest: digest, acknowledged: false }]),
    });
  const forged = await post("https://evil.example");
  const forgedBody = await forged.text();
  expect(forgedBody).not.toContain("HELD");
  expect((await snapshot([m.id])).holds).toHaveLength(0); // refused: nothing was held
  const genuine = await post(BASE);
  expect(await genuine.text()).toContain("HELD");
  const afterGenuine = await snapshot([m.id]);
  expect(afterGenuine.holds).toHaveLength(1);
  evidence["CSRF"] = { forgedOriginStatus: forged.status(), forgedHeldAnything: false, holdsAfterForged: 0, sameOriginControlStatus: genuine.status(), holdsAfterControl: afterGenuine.holds.length };
  await context.close();
});

test("AC-34: a different quote with the SAME total is refused and holds nothing; the refreshed quote then holds", async ({ browser }) => {
  const a = await fixed(50_000, 100_000, { name: "harness A" });
  const b = await fixed(50_000, 100_000, { name: "harness B" });
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: a.id });
  const context = await buyer(browser, c.id);
  const page = await context.newPage();
  const net: Net[] = [];
  watch(page, net);
  await loadHarness(page);
  const seen = await page.locator("[data-harness=voucher-hold]").getAttribute("data-digest");
  const totalSeen = await page.getByTestId("total").textContent();
  // Another tab switches the cart to the other voucher of equal value.
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: b.id });

  await click(page, net, "hold");
  const refused = await shown(page);
  expect(refused).toMatchObject({ ok: false, reason: "QUOTE_CHANGED" });
  const afterRefusal = await snapshot([a.id, b.id]);
  expect(afterRefusal.holds).toHaveLength(0);
  expect(afterRefusal.campaigns.every((x) => x.reservedUses === 0 && x.reservedVnd === 0)).toBe(true);

  await page.reload();
  expect(await page.getByTestId("total").textContent()).toBe(totalSeen); // equal total, different quote
  expect(await page.locator("[data-harness=voucher-hold]").getAttribute("data-digest")).not.toBe(seen);
  await click(page, net, "hold");
  expect(await shown(page)).toMatchObject({ ok: true, state: "HELD" });
  const held = await snapshot([a.id, b.id]);
  expect(held.holds).toHaveLength(1);
  expect(held.holds[0]!.campaign).toBe(`campaign${[a.id, b.id].sort().indexOf(b.id) + 1}`); // the hold is on the voucher now shown (B), not the stale one (A)
  evidence["AC-34-same-total"] = { totalShown: totalSeen, refusedReason: "QUOTE_CHANGED", databaseAfterRefusal: afterRefusal, databaseAfterRefresh: held };
  await context.close();
});

test("AC-34: a quote that raises the total needs consent: without it nothing is held, with it exactly one hold", async ({ browser }) => {
  const m = await fixed(10_000, 50_000);
  const c = await cart([{ variantId: await product(100_000, { category: "vayDam" }), quantity: 1 }]);
  await prisma.shippingPromotionCampaign.create({ data: { pancakeShopId: SHOP, name: "Harness freeship", isEnabled: true, enabledAt: PAST, minimumQuantity: 1, priority: 1, stackingEnabled: false, categoryKeys: ["vayDam"] } });
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id }); // the buyer insists on a voucher that makes shipping cost 30.000
  const context = await buyer(browser, c.id);
  const page = await context.newPage();
  const net: Net[] = [];
  watch(page, net);
  await loadHarness(page);
  await expect(page.getByTestId("total")).toHaveText("120000"); // 100.000 + 30.000 shipping - 10.000 voucher
  await click(page, net, "hold");
  expect(await shown(page)).toMatchObject({ ok: false, reason: "CONFIRMATION_REQUIRED" });
  const refused = await snapshot([m.id]);
  expect(refused.holds).toHaveLength(0);
  expect(refused.campaigns[0]).toMatchObject({ reservedUses: 0, reservedVnd: 0 });

  await click(page, net, "hold-ack");
  expect(await shown(page)).toMatchObject({ ok: true, state: "HELD", totalPayableVnd: 120_000 });
  const granted = await snapshot([m.id]);
  expect(granted.holds).toHaveLength(1);
  evidence["consent"] = { withoutConsent: { reason: "CONFIRMATION_REQUIRED", database: refused }, withConsent: { database: granted } };
  await context.close();
});

test("a proof that cannot be issued rolls the whole call back: the quota is not lost and the next buyer can take it", async ({ browser }) => {
  // A legitimate cart at the line limit: 50 products with long variation ids, 2 units each, and a voucher whose
  // exact allocation leaves every line at two price segments => 100 signed lines, past the proof's 16 KiB envelope.
  const m = await fixed(49_950, 600_000, { maxUses: 1 });
  const items: Array<{ variantId: string; quantity: number }> = [];
  for (let i = 0; i < 50; i += 1) items.push({ variantId: await product(20_000, { variationId: `${P}-${i}-${"x".repeat(100)}` }), quantity: 2 });
  const big = await cart(items);
  const small = await cart([{ variantId: await product(450_000), quantity: 2 }]);

  const bigContext = await buyer(browser, big.id);
  const bigPage = await bigContext.newPage();
  const net: Net[] = [];
  watch(bigPage, net);
  await loadHarness(bigPage);
  await expect(bigPage.getByTestId("selection")).toContainText(m.id); // the voucher IS chosen for this cart
  await click(bigPage, net, "hold");
  expect(await shown(bigPage)).toMatchObject({ ok: false, reason: "PROOF_UNAVAILABLE" });
  const afterFailure = await snapshot([m.id]);
  expect(afterFailure.holds).toHaveLength(0);
  expect(afterFailure.campaigns[0]).toMatchObject({ reservedUses: 0, reservedVnd: 0 });

  // The only use is still there for someone else.
  const smallContext = await buyer(browser, small.id);
  const smallPage = await smallContext.newPage();
  const net2: Net[] = [];
  watch(smallPage, net2);
  await loadHarness(smallPage);
  await click(smallPage, net2, "hold");
  expect(await shown(smallPage)).toMatchObject({ ok: true, state: "HELD" });
  const afterOther = await snapshot([m.id]);
  expect(afterOther.holds).toHaveLength(1);
  expect(afterOther.campaigns[0]).toMatchObject({ reservedUses: 1 });
  evidence["proof-failure"] = { reason: "PROOF_UNAVAILABLE", cartLines: items.length, signedProofLines: 100, databaseAfterFailure: afterFailure, databaseAfterNextBuyer: afterOther };
  await bigContext.close();
  await smallContext.close();
});

export type { Snapshot };
