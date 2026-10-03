import assert from "node:assert/strict";
import test from "node:test";

import {
  quarantineZaloAdsPixel,
  readZaloAdsPixelState,
  startZaloAdsPixel,
  watchZaloAdsLocation,
  ZALO_ADS_QUARANTINE_ID,
  ZALO_ADS_SCRIPT_ID,
  type GuardDocument,
  type GuardWindow,
} from "../../src/integrations/zalo-ads/pixel-guard.ts";

const ORIGIN = "https://lanadesign.example";
const SRC = "https://s.zzcdn.me/ztr/ztracker.js?id=7242087840828522496";
const POLICY = "img-src 'self'; connect-src 'self'";

type FakeElement = Record<string, unknown> & { id: string };
type Listener = (event: unknown) => void;

function fakeDom(href: string, referrer = "", withNavigationApi = true) {
  const head: FakeElement[] = [];
  const listeners = new Map<string, Listener[]>();
  const navigationListeners = new Map<string, Listener[]>();
  const add = (map: Map<string, Listener[]>) => (type: string, listener: Listener) =>
    map.set(type, [...(map.get(type) ?? []), listener]);
  const remove = (map: Map<string, Listener[]>) => (type: string, listener: Listener) =>
    map.set(type, (map.get(type) ?? []).filter((entry) => entry !== listener));

  const location = { href, origin: ORIGIN };
  const win: GuardWindow = {
    location,
    addEventListener: add(listeners),
    removeEventListener: remove(listeners),
    navigation: withNavigationApi
      ? { addEventListener: add(navigationListeners), removeEventListener: remove(navigationListeners) }
      : undefined,
  };
  const doc = {
    referrer,
    head: { appendChild: (node: FakeElement) => head.push(node) },
    documentElement: { dataset: {} as Record<string, string | undefined> },
    getElementById: (id: string) => head.find((node) => node.id === id) ?? null,
    createElement: () => ({ id: "" }) as FakeElement,
  } as unknown as GuardDocument;

  return {
    win,
    doc,
    head,
    /** A same-document URL change as the browser performs it: URL first, then the event. */
    changeHash(next: string) {
      location.href = next;
      for (const listener of listeners.get("hashchange") ?? []) listener({});
    },
    /** The Navigation API's navigate event, which fires before the URL commits. */
    navigate(destination: string) {
      for (const listener of navigationListeners.get("navigate") ?? []) listener({ destination: { url: destination } });
    },
    listenerCount: () =>
      [...listeners.values(), ...navigationListeners.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

const scripts = (head: FakeElement[]) => head.filter((node) => node.id === ZALO_ADS_SCRIPT_ID);
const quarantines = (head: FakeElement[]) => head.filter((node) => node.id === ZALO_ADS_QUARANTINE_ID);

test("a safe address and referrer insert exactly the official async tag, once per document", () => {
  const dom = fakeDom(`${ORIGIN}/?zaclid=abc`, "https://zalo.me/");
  assert.equal(startZaloAdsPixel(dom.win, dom.doc, SRC), "loaded");
  assert.equal(startZaloAdsPixel(dom.win, dom.doc, SRC), "loaded");
  assert.deepEqual(scripts(dom.head), [{ id: ZALO_ADS_SCRIPT_ID, async: true, src: SRC }]);
});

test("an unsafe address, fragment or same-origin referrer keeps the tag out of the document", () => {
  for (const [href, referrer] of [
    [`${ORIGIN}/shop?q=alice%40example.com`, ""],
    [`${ORIGIN}/track-order?order=LA-1`, ""],
    [`${ORIGIN}/#alice@example.com`, ""],
    [`${ORIGIN}/shop`, `${ORIGIN}/shop?q=alice%40example.com`],
  ]) {
    const dom = fakeDom(href, referrer);
    assert.equal(startZaloAdsPixel(dom.win, dom.doc, SRC), "blocked", `${href} ← ${referrer}`);
    assert.deepEqual(scripts(dom.head), []);
    // A blocked document is never quarantined: there is nothing loaded to cut off.
    assert.equal(quarantineZaloAdsPixel(dom.win, dom.doc, POLICY, [`${ORIGIN}/shop?q=x`]), false);
    assert.deepEqual(quarantines(dom.head), []);
  }
});

test("safe load, then an unsafe hash mutation: the Zalo reporting origin is withheld", () => {
  const dom = fakeDom(`${ORIGIN}/shop`);
  startZaloAdsPixel(dom.win, dom.doc, SRC);
  // Without the Navigation API only hashchange observes it.
  const fallback = fakeDom(`${ORIGIN}/shop`, "", false);
  startZaloAdsPixel(fallback.win, fallback.doc, SRC);

  for (const { win, doc, head, changeHash } of [dom, fallback]) {
    watchZaloAdsLocation(win, doc, POLICY);
    changeHash(`${ORIGIN}/shop#alice@example.com`);
    assert.equal(readZaloAdsPixelState(doc), "quarantined");
    assert.deepEqual(quarantines(head), [{ id: ZALO_ADS_QUARANTINE_ID, httpEquiv: "Content-Security-Policy", content: POLICY }]);
  }
});

test("the Navigation API quarantines before an unsafe URL commits", () => {
  const dom = fakeDom(`${ORIGIN}/`);
  startZaloAdsPixel(dom.win, dom.doc, SRC);
  watchZaloAdsLocation(dom.win, dom.doc, POLICY);

  dom.navigate(`${ORIGIN}/#alice@example.com`);
  // The address has not changed yet, and the document is already cut off.
  assert.equal(dom.win.location.href, `${ORIGIN}/`);
  assert.equal(readZaloAdsPixelState(dom.doc), "quarantined");
});

test("a safe anchor keeps tracking, and quarantine is one-way and inserted once", () => {
  const dom = fakeDom(`${ORIGIN}/shipping`);
  startZaloAdsPixel(dom.win, dom.doc, SRC);
  const stop = watchZaloAdsLocation(dom.win, dom.doc, POLICY);

  dom.changeHash(`${ORIGIN}/shipping#thanh-toan`);
  dom.navigate(`${ORIGIN}/contact`);
  assert.equal(readZaloAdsPixelState(dom.doc), "loaded");
  assert.deepEqual(quarantines(dom.head), []);

  // Router-driven check: the target carries a search term the address bar does not show yet.
  assert.equal(quarantineZaloAdsPixel(dom.win, dom.doc, POLICY, [`${ORIGIN}/shop?q=alice`, dom.win.location.href]), true);
  dom.changeHash(`${ORIGIN}/shipping#thanh-toan`);
  assert.equal(readZaloAdsPixelState(dom.doc), "quarantined");
  assert.equal(quarantines(dom.head).length, 1);

  stop();
  assert.equal(dom.listenerCount(), 0);
});

test("a DOM that throws never escapes into the page", () => {
  const dom = fakeDom(`${ORIGIN}/`);
  const broken = {
    ...dom.doc,
    head: {
      appendChild: () => {
        throw new Error("blocked");
      },
    },
  } as unknown as GuardDocument;
  assert.doesNotThrow(() => startZaloAdsPixel(dom.win, broken, SRC));
  const hostile = {
    ...dom.win,
    addEventListener: () => {
      throw new Error("nope");
    },
  } as unknown as GuardWindow;
  assert.doesNotThrow(() => watchZaloAdsLocation(hostile, dom.doc, POLICY)());
});
