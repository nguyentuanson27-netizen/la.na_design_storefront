import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { whenMetaBrowserIdKnown } from "../../src/components/analytics/meta-browser-id-wait.ts";

function replaceGlobal(name: "window" | "document", value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, previous);
  };
}

/** A page with the pixel snippet's script element, its cookies and its hide events. */
function fakePage(t: TestContext, options: { cookie?: string; status?: string | null } = {}) {
  const page = {
    cookie: options.cookie ?? "la_session=1",
    status: options.status === undefined ? "loading" : options.status,
    visibilityState: "visible",
    clock: 0,
    listeners: new Map<string, Set<() => void>>(),
  };
  const target = (scope: string) => ({
    addEventListener(type: string, listener: () => void) {
      const key = `${scope}:${type}`;
      if (!page.listeners.has(key)) page.listeners.set(key, new Set());
      page.listeners.get(key)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      page.listeners.get(`${scope}:${type}`)?.delete(listener);
    },
  });
  const restoreWindow = replaceGlobal("window", target("window"));
  const restoreDocument = replaceGlobal("document", {
    ...target("document"),
    get cookie() { return page.cookie; },
    get visibilityState() { return page.visibilityState; },
    querySelector() {
      return page.status === null ? null : { dataset: { laMetaPixelStatus: page.status } };
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    restoreDocument();
    restoreWindow();
  });
  return {
    page,
    now: () => page.clock,
    advance(ms: number) {
      for (let step = 0; step < ms; step += 100) {
        page.clock += 100;
        t.mock.timers.tick(100);
      }
    },
    dispatch(scope: string, type: string) {
      for (const listener of [...(page.listeners.get(`${scope}:${type}`) ?? [])]) listener();
    },
    listenerCount() {
      return [...page.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

test("a returning shopper's signal leaves at once", (t) => {
  const { now, listenerCount } = fakePage(t, { cookie: "la_session=1; _fbp=fb.1.1700000000000.1" });
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  assert.equal(sent, 1);
  assert.equal(listenerCount(), 0);
});

test("a first-visit signal waits for fbevents.js to write _fbp, then leaves once", (t) => {
  const { page, now, advance, listenerCount } = fakePage(t);
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  advance(500);
  assert.equal(sent, 0);

  page.cookie = "la_session=1; _fbp=fb.1.1700000000000.1";
  advance(100);
  assert.equal(sent, 1);
  advance(5_000);
  assert.equal(sent, 1);
  assert.equal(listenerCount(), 0);
});

test("a blocked pixel never holds the server twin back", (t) => {
  const { page, now, advance } = fakePage(t);
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  page.status = "unavailable";
  advance(100);
  assert.equal(sent, 1);
});

test("a loaded library that writes no cookie releases the signal after a short grace", (t) => {
  const { page, now, advance } = fakePage(t);
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  page.status = "ready";
  advance(200);
  assert.equal(sent, 0);
  advance(200);
  assert.equal(sent, 1);
});

test("a pixel that never settles still sends by the deadline", (t) => {
  const { now, advance } = fakePage(t, { status: null });
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  advance(1_900);
  assert.equal(sent, 0);
  advance(100);
  assert.equal(sent, 1);
});

test("leaving the page flushes the waiting signal instead of dropping it", (t) => {
  const { page, now, advance, dispatch, listenerCount } = fakePage(t);
  let sent = 0;
  whenMetaBrowserIdKnown(() => { sent += 1; }, now);
  page.visibilityState = "hidden";
  dispatch("document", "visibilitychange");
  assert.equal(sent, 1);

  dispatch("window", "pagehide");
  advance(3_000);
  assert.equal(sent, 1);
  assert.equal(listenerCount(), 0);
});

test("a throwing sender cannot escape the timer", (t) => {
  const { page, now, advance } = fakePage(t);
  whenMetaBrowserIdKnown(() => { throw new Error("fetch unavailable"); }, now);
  page.status = "unavailable";
  assert.doesNotThrow(() => advance(100));
});
