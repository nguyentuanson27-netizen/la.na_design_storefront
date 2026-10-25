import assert from "node:assert/strict";
import test from "node:test";

const PIXEL_ID = "123456789012345";

function replaceGlobal(name: "window" | "document", value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, name);
      return;
    }
    Object.defineProperty(globalThis, name, previous);
  };
}

function fakeScript(status: "loading" | "ready" | "unavailable") {
  const listeners = new Map<string, EventListener>();
  let listenerRegistrations = 0;
  return {
    script: {
      dataset: { laMetaPixelStatus: status },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listenerRegistrations += 1;
        listeners.set(type, listener as EventListener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    },
    listener(type: string) {
      return listeners.get(type) ?? null;
    },
    registrations() {
      return listenerRegistrations;
    },
  };
}

test("an already-finished no-op pixel script cannot retain or later revive its acknowledgement", async (t) => {
  const previousPixelId = process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
  process.env.LA_BUILD_FACEBOOK_PIXEL_ID = PIXEL_ID;
  t.after(() => {
    if (previousPixelId === undefined) delete process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
    else process.env.LA_BUILD_FACEBOOK_PIXEL_ID = previousPixelId;
  });

  const fbq = (..._args: unknown[]) => {};
  const failedScript = fakeScript("unavailable");
  let currentScript = failedScript.script;

  const restoreWindow = replaceGlobal("window", { fbq });
  const restoreDocument = replaceGlobal("document", {
    querySelector() {
      return currentScript;
    },
  });
  t.after(() => {
    restoreDocument();
    restoreWindow();
  });

  const { trackFacebookPixelEvent } = await import(
    "../../src/components/analytics/facebook-pixel-client.ts"
  );

  let accepted = 0;
  trackFacebookPixelEvent("Purchase", { currency: "VND", value: 449_000 }, "ORDER-1", () => {
    accepted += 1;
  });

  // The terminal state was recorded before this subscriber existed. Waiting for `load` now would
  // miss an event that has already happened and retain the acknowledgement callback forever.
  assert.equal(failedScript.registrations(), 0);
  assert.equal(accepted, 0);
  assert.equal(typeof (fbq as { callMethod?: unknown }).callMethod, "undefined");

  // Prove that acknowledgement was discarded rather than merely hidden. A later healthy script
  // may acknowledge its own event, but must never revive the Purchase callback from the dead script.
  const recoveryScript = fakeScript("loading");
  currentScript = recoveryScript.script;
  trackFacebookPixelEvent("Purchase", { currency: "VND", value: 449_000 }, "ORDER-2", () => {
    accepted += 1;
  });
  assert.equal(recoveryScript.registrations(), 2);

  (fbq as { callMethod?: unknown }).callMethod = fbq;
  recoveryScript.script.dataset.laMetaPixelStatus = "ready";
  const load = recoveryScript.listener("load");
  assert.notEqual(load, null);
  load!({} as Event);

  assert.equal(accepted, 1);
});

test("a custom UX event queued before the snippet runs is sent with trackCustom, in order", async (t) => {
  const previousPixelId = process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
  process.env.LA_BUILD_FACEBOOK_PIXEL_ID = PIXEL_ID;
  t.after(() => {
    if (previousPixelId === undefined) delete process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
    else process.env.LA_BUILD_FACEBOOK_PIXEL_ID = previousPixelId;
  });

  const host: { fbq?: (...args: unknown[]) => void } = {};
  const restoreWindow = replaceGlobal("window", host);
  const restoreDocument = replaceGlobal("document", { querySelector: () => null });
  t.after(() => {
    restoreDocument();
    restoreWindow();
  });

  // A module instance of its own: the queue is module state, and the test above leaves a pixel behind.
  const specifier = "../../src/components/analytics/facebook-pixel-client.ts";
  const { trackFacebookPixelCustomEvent, trackFacebookPixelEvent } = (await import(
    `${specifier}?custom-event`
  )) as typeof import("../../src/components/analytics/facebook-pixel-client.ts");

  trackFacebookPixelCustomEvent("CartDrawerExit", { exit_to: "close", gift_nudge: true, can_checkout: true });

  const calls: unknown[][] = [];
  host.fbq = (...args: unknown[]) => {
    calls.push(args);
  };
  trackFacebookPixelEvent("PageView");

  assert.deepEqual(calls, [
    ["trackCustom", "CartDrawerExit", { exit_to: "close", gift_nudge: true, can_checkout: true }],
    ["track", "PageView", undefined],
  ]);
  // Let the appearance poll notice fbq and stop itself.
  await new Promise((resolve) => setTimeout(resolve, 300));
});
