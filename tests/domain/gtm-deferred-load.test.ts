import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import {
  buildGtmLoaderSnippet,
  GTM_EAGER_CHECK_GLOBAL,
  GTM_INTERACTION_EVENTS,
  GTM_LOAD_FALLBACK_MS,
} from "../../src/integrations/gtm/loader-snippet.ts";

/**
 * Runs the real inline snippet against a stand-in browser. No network, no real timers: the
 * stand-in records what the snippet registers and lets the test fire it.
 */
function runSnippet(options: { readyState?: string; nonce?: string; pathname?: string } = {}) {
  const listeners = new Map<string, Array<{ fn: () => void; capture: boolean }>>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const inserted: Array<{ src: string; attrs: Record<string, string> }> = [];

  const window = {
    addEventListener(type: string, fn: () => void, opts?: boolean | { capture?: boolean }) {
      const capture = typeof opts === "object" ? Boolean(opts.capture) : Boolean(opts);
      listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture }]);
    },
    removeEventListener(type: string, fn: () => void, opts?: boolean | { capture?: boolean }) {
      const capture = typeof opts === "object" ? Boolean(opts.capture) : Boolean(opts);
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => !(entry.fn === fn && entry.capture === capture)),
      );
    },
    dataLayer: undefined as Array<Record<string, unknown>> | undefined,
    location: { pathname: options.pathname ?? "/" },
  } as Record<string, unknown> & { location: { pathname: string }; dataLayer?: Array<Record<string, unknown>> };
  const anchor = { parentNode: { insertBefore: (el: { src: string; attrs: Record<string, string> }) => inserted.push(el) } };
  const document = {
    readyState: options.readyState ?? "interactive",
    querySelector: (selector: string) =>
      selector === "[nonce]" && options.nonce !== undefined
        ? { nonce: options.nonce, getAttribute: () => "" }
        : null,
    getElementsByTagName: () => [anchor],
    createElement: () => {
      const attrs: Record<string, string> = {};
      return { src: "", async: false, attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
    },
  };
  const sandbox = {
    window,
    document,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    Date,
  };
  vm.runInNewContext(buildGtmLoaderSnippet("GTM-TEST123"), { ...sandbox, window, document });

  return {
    window,
    inserted,
    timers,
    fire: (type: string) => (listeners.get(type) ?? []).forEach((entry) => entry.fn()),
    listenerCount: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
    listenerTypes: () => [...listeners.keys()],
  };
}

test("gtm.start reaches the dataLayer immediately, but gtm.js is not requested yet", () => {
  const page = runSnippet();
  assert.equal(page.window.dataLayer?.length, 1);
  assert.equal(page.window.dataLayer?.[0]?.event, "gtm.js");
  assert.ok(typeof page.window.dataLayer?.[0]?.["gtm.start"] === "number");
  assert.deepEqual(page.inserted, []);
});

for (const type of GTM_INTERACTION_EVENTS) {
  test(`the first ${type} releases gtm.js exactly once for the configured container`, () => {
    const page = runSnippet();
    page.fire(type);
    page.fire(type);
    page.fire("keydown");
    assert.equal(page.inserted.length, 1);
    assert.equal(page.inserted[0]!.src, "https://www.googletagmanager.com/gtm.js?id=GTM-TEST123");
    assert.equal(page.listenerCount() <= 1, true, "interaction listeners are removed once it has loaded");
  });
}

test("with no interaction, gtm.js is released by the fallback timer armed after load", () => {
  const page = runSnippet({ readyState: "loading" });
  assert.equal(page.timers.length, 0, "no timer before the document has loaded");
  page.fire("load");
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0]!.ms, GTM_LOAD_FALLBACK_MS);
  assert.equal(page.inserted.length, 0);
  page.timers[0]!.fn();
  assert.equal(page.inserted.length, 1);
});

test("an already-loaded document arms the fallback straight away", () => {
  const page = runSnippet({ readyState: "complete" });
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0]!.ms, GTM_LOAD_FALLBACK_MS);
});

test("interaction followed by the timer still inserts gtm.js once", () => {
  const page = runSnippet({ readyState: "complete" });
  page.fire("pointerdown");
  page.timers[0]!.fn();
  assert.equal(page.inserted.length, 1);
});

test("the page's script nonce is carried onto gtm.js", () => {
  const page = runSnippet({ nonce: "abc123" });
  page.fire("keydown");
  assert.equal(page.inserted[0]!.attrs.nonce, "abc123");
});

test("no nonce on the page means none is set", () => {
  const page = runSnippet();
  page.fire("keydown");
  assert.equal("nonce" in page.inserted[0]!.attrs, false);
});

test("a scroll event is not an interaction: the storefront scrolls itself for #san-pham deep links", () => {
  assert.equal((GTM_INTERACTION_EVENTS as readonly string[]).includes("scroll"), false);
  const page = runSnippet({ readyState: "complete" });
  assert.equal(page.listenerTypes().includes("scroll"), false, "no scroll listener is registered");
  page.fire("scroll");
  assert.equal(page.inserted.length, 0);
  // ...while a person's own scrolling still starts with one of the listed events.
  page.fire("touchstart");
  assert.equal(page.inserted.length, 1);
});

for (const pathname of ["/cart", "/checkout", "/checkout/success", "/en/cart", "/en/checkout/success"]) {
  test(`${pathname} loads gtm.js at once, because conversions are measured there`, () => {
    const page = runSnippet({ pathname });
    assert.equal(page.inserted.length, 1, "no wait for an interaction or the fallback timer");
    assert.equal(page.inserted[0]!.src, "https://www.googletagmanager.com/gtm.js?id=GTM-TEST123");
    assert.equal(page.window.dataLayer?.[0]?.event, "gtm.js", "gtm.start is still pushed first");
    assert.equal(page.timers.length, 0);
  });
}

for (const pathname of ["/", "/ao-dai", "/shop/some-dress", "/checkout-guide", "/cartoon", "/en", "/policies/checkout"]) {
  test(`${pathname} still waits for an interaction`, () => {
    const page = runSnippet({ pathname });
    assert.equal(page.inserted.length, 0);
  });
}

// The root layout survives client navigation, so the pathname can change after the snippet ran.
// GtmRouteWatcher calls the hook below on every route change.
function routeChangesTo(page: ReturnType<typeof runSnippet>, pathname: string) {
  page.window.location.pathname = pathname;
  const check = page.window[GTM_EAGER_CHECK_GLOBAL];
  assert.equal(typeof check, "function", "the snippet leaves its re-check hook on window");
  (check as () => void)();
}

for (const pathname of ["/checkout/success", "/en/checkout/success", "/cart", "/en/cart", "/checkout"]) {
  test(`a client navigation from / to ${pathname} loads gtm.js at once, with no interaction`, () => {
    const page = runSnippet({ readyState: "complete", pathname: "/" });
    assert.equal(page.inserted.length, 0, "waiting on the landing page");
    routeChangesTo(page, pathname);
    assert.equal(page.inserted.length, 1);
    assert.equal(page.inserted[0]!.src, "https://www.googletagmanager.com/gtm.js?id=GTM-TEST123");
    // Only once, however many more route changes, interactions or timers follow.
    routeChangesTo(page, "/checkout/success");
    page.fire("pointerdown");
    page.timers[0]!.fn();
    assert.equal(page.inserted.length, 1);
  });
}

test("a client navigation to a page that is not a conversion page keeps waiting", () => {
  const page = runSnippet({ readyState: "complete", pathname: "/" });
  routeChangesTo(page, "/ao-dai");
  routeChangesTo(page, "/shop/some-dress");
  routeChangesTo(page, "/checkout-guide");
  assert.equal(page.inserted.length, 0);
  page.fire("keydown");
  assert.equal(page.inserted.length, 1, "an interaction still releases it");
});

test("the hook is harmless once the container has loaded, and on a page that loaded eagerly", () => {
  const eager = runSnippet({ pathname: "/checkout" });
  assert.equal(eager.inserted.length, 1);
  routeChangesTo(eager, "/cart");
  routeChangesTo(eager, "/");
  assert.equal(eager.inserted.length, 1);

  const released = runSnippet({ readyState: "complete" });
  released.fire("touchstart");
  routeChangesTo(released, "/checkout/success");
  assert.equal(released.inserted.length, 1);
});

test("GtmRouteWatcher is mounted by the loader and calls the hook on each pathname change", async () => {
  const root = new URL("../../src/", import.meta.url);
  const watcher = await readFile(new URL("components/analytics/gtm-route-watcher.tsx", root), "utf8");
  const loader = await readFile(new URL("components/analytics/google-tag-manager.tsx", root), "utf8");
  assert.match(watcher, /^"use client";/);
  assert.match(watcher, /usePathname\(\)/);
  assert.match(watcher, /GTM_EAGER_CHECK_GLOBAL/);
  assert.match(watcher, /\[pathname\]\)/, "the effect is keyed on the pathname");
  assert.match(loader, /<GtmRouteWatcher \/>/);
  // Client code must not import the snippet builder, which holds the vendor strings.
  assert.doesNotMatch(watcher, /loader-snippet/);
});
