import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Guards the one seam Phase D deliberately did not split.
 *
 * The brand checkout entry point is an adapter over the shared guest checkout form, because that
 * form is a workflow -- quote proof, geo narrowing, and a server action that is the only authority
 * on acceptance -- and a second implementation of it is a second set of the bugs that come with
 * getting that order wrong. These tests fail if a fork starts.
 */

const BRAND_ADAPTER = new URL("../../src/components/brand/guest-checkout-form.tsx", import.meta.url);

test("the brand checkout adapter renders the shared form rather than reimplementing it", async () => {
  const source = await readFile(BRAND_ADAPTER, "utf8");

  assert.match(source, /from "@\/components\/commerce\/guest-checkout-form"/);
  assert.match(source, /<GuestCheckoutForm/);
});

test("the brand checkout adapter runs none of the checkout workflow itself", async () => {
  const source = await readFile(BRAND_ADAPTER, "utf8");

  for (const forbidden of [
    "submitGuestCheckoutAction",
    "checkout-geo-actions",
    "useActionState",
    "quoteProof.",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the adapter must not carry ${forbidden}: that is the shared form's job`,
    );
  }
});

test("exactly one component submits guest checkout", async () => {
  // A fork would show up here first: two components importing the submit action means two
  // implementations of the workflow behind it.
  const roots = ["commerce", "brand", "analytics"] as const;
  const submitters: string[] = [];

  for (const root of roots) {
    const directory = new URL(`../../src/components/${root}/`, import.meta.url);
    for (const entry of await readdir(directory)) {
      const source = await readFile(new URL(entry, directory), "utf8");
      if (source.includes("submitGuestCheckoutAction")) submitters.push(`${root}/${entry}`);
    }
  }

  assert.deepEqual(submitters, ["commerce/guest-checkout-form.tsx"]);
});

/**
 * The order-lookup adapter, guarded on the same grounds.
 *
 * The lookup is a server action that decides whether an order-code/phone pair identifies an order
 * and which of its fields a guest may see. A second implementation is a second set of the bugs that
 * come with getting that wrong, and the failure mode is showing one customer another's order.
 */

const BRAND_TRACKING_ADAPTER = new URL(
  "../../src/components/brand/guest-order-tracking-form.tsx",
  import.meta.url,
);

test("the brand order-lookup adapter renders the shared form rather than reimplementing it", async () => {
  const source = await readFile(BRAND_TRACKING_ADAPTER, "utf8");

  assert.match(source, /from "@\/components\/commerce\/guest-order-tracking-form"/);
  assert.match(source, /<GuestOrderTrackingForm/);
});

test("exactly one component looks up a guest order", async () => {
  const roots = ["commerce", "brand", "analytics"] as const;
  const lookers: string[] = [];

  for (const root of roots) {
    const directory = new URL(`../../src/components/${root}/`, import.meta.url);
    for (const entry of await readdir(directory)) {
      const source = await readFile(new URL(entry, directory), "utf8");
      if (source.includes("lookupGuestOrderAction")) lookers.push(`${root}/${entry}`);
    }
  }

  assert.deepEqual(lookers, ["commerce/guest-order-tracking-form.tsx"]);
});
