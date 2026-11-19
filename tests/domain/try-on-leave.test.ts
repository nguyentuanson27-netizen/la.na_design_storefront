import assert from "node:assert/strict";
import test from "node:test";

import {
  isExitIntent,
  isUnloadingClick,
  leaveOffer,
  type LeaveClick,
} from "../../src/components/headless/try-on-leave.ts";

const ORIGIN = "https://lanadesign.vn";

function click(overrides: Partial<LeaveClick>): LeaveClick {
  return {
    href: `${ORIGIN}/ao-dai`,
    origin: ORIGIN,
    target: "",
    download: false,
    reloads: false,
    button: 0,
    modified: false,
    defaultPrevented: false,
    ...overrides,
  };
}

test("a link inside the app is let through: the dock carries the job across", () => {
  assert.equal(isUnloadingClick(click({})), false);
  assert.equal(isUnloadingClick(click({ href: `${ORIGIN}/shop/vay-hoa#mua-hang` })), false);
  assert.equal(isUnloadingClick(click({ href: `${ORIGIN}/ao-dai#top` })), false);
});

test("a link to another site unloads the page, so it is held back", () => {
  assert.equal(isUnloadingClick(click({ href: "https://zalo.me/123" })), true);
  assert.equal(isUnloadingClick(click({ href: "https://sub.lanadesign.vn/" })), true);
  assert.equal(isUnloadingClick(click({ href: "http://lanadesign.vn/" })), true);
});

test("a plain anchor the app uses for a full reload (the language switcher) is held back too", () => {
  assert.equal(isUnloadingClick(click({ href: `${ORIGIN}/en/ao-dai`, reloads: true })), true);
});

test("clicks that leave this page alone are never held back", () => {
  const external = "https://zalo.me/123";
  assert.equal(isUnloadingClick(click({ href: external, target: "_blank" })), false);
  assert.equal(isUnloadingClick(click({ href: external, target: "_self" })), true);
  assert.equal(isUnloadingClick(click({ href: external, modified: true })), false);
  assert.equal(isUnloadingClick(click({ href: external, button: 1 })), false);
  assert.equal(isUnloadingClick(click({ href: external, download: true })), false);
  assert.equal(isUnloadingClick(click({ href: external, defaultPrevented: true })), false);
  assert.equal(isUnloadingClick(click({ href: "mailto:hello@lanadesign.vn" })), false);
  assert.equal(isUnloadingClick(click({ href: "tel:+84900000000" })), false);
  assert.equal(isUnloadingClick(click({ href: "javascript:void(0)" })), false);
  assert.equal(isUnloadingClick(click({ href: "not a url" })), false);
});

test("only a mouse leaving through the top of the window counts as an exit intent", () => {
  const base = { clientY: 0, relatedTarget: null, finePointer: true };
  assert.equal(isExitIntent(base), true);
  assert.equal(isExitIntent({ ...base, clientY: -12 }), true);
  assert.equal(isExitIntent({ ...base, clientY: 300 }), false, "left through a side or the bottom");
  assert.equal(isExitIntent({ ...base, relatedTarget: {} as EventTarget }), false, "moved to another element");
  assert.equal(isExitIntent({ ...base, finePointer: false }), false, "touch has no such movement");
});

test("the choices that need a link are offered only when there is one", () => {
  assert.deepEqual(leaveOffer("https://zalo.me/123"), { newTab: true, leave: true });
  assert.deepEqual(leaveOffer(null), { newTab: false, leave: false });
});
