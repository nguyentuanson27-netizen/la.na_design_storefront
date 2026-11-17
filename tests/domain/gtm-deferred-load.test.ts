import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  buildGtmLoaderSnippet,
  GTM_INTERACTION_EVENTS,
  GTM_LOAD_FALLBACK_MS,
} from "../../src/integrations/gtm/loader-snippet.ts";

/**
 * Runs the real inline snippet against a stand-in browser. No network, no real timers: the
 * stand-in records what the snippet registers and lets the test fire it.
 */
function runSnippet(options: { readyState?: string; nonce?: string } = {}) {
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
  };
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
