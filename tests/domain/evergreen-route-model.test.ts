import assert from "node:assert/strict";
import test from "node:test";

import { BRAND } from "../../src/brand/index.ts";
import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_LEGAL_FACTS,
} from "../../src/content/public-brand-facts.ts";
import {
  buildAboutViewModel,
  buildContactViewModel,
} from "../../src/routes/evergreen-model.ts";

/**
 * The evergreen pages' view models.
 *
 * What these guard is provenance, not wording: every field must come from the fact authority, so
 * that a fork changing a fact changes the page. A test asserting the literal Vietnamese text would
 * pass just as happily against a value transcribed into the model, which is the failure that
 * matters here.
 */

test("About reads the approved positioning rather than page prose", () => {
  assert.equal(buildAboutViewModel().positioning, PUBLIC_BRAND_POSITIONING);
});

test("About reads the legal facts and the shared address helper", () => {
  const model = buildAboutViewModel();

  assert.equal(model.legalEntityName, PUBLIC_LEGAL_FACTS.legalEntityName);
  assert.equal(model.taxCode, PUBLIC_LEGAL_FACTS.taxCode);
  // The same call the footer and the Organization node use, not a second address format.
  assert.equal(model.address, describePublicAddress());
});

test("About states only what B6 approved", () => {
  // A founding year, founder or brand story arriving here is the regression this pins: the owner
  // withheld them, and no approved source states them.
  assert.deepEqual(Object.keys(buildAboutViewModel()).sort(), [
    "address",
    "legalEntityName",
    "positioning",
    "taxCode",
  ]);
});

test("Contact reads every channel from the contact facts", () => {
  const model = buildContactViewModel();

  assert.equal(model.telephone, BRAND.contact.telephone);
  assert.equal(model.telephoneInternational, BRAND.contact.telephoneInternational);
  assert.equal(model.email, BRAND.contact.email);
  assert.equal(model.fanpageUrl, BRAND.contact.fanpageUrl);
  assert.equal(model.address, describePublicAddress());
  assert.equal(model.supportHours, describePublicSupportHours());
});

test("the fanpage label follows the configured URL instead of naming a fixed page", () => {
  // It used to be written into the markup, so a brand that changed `fanpageUrl` would have shipped
  // a link whose text named someone else's page.
  const { fanpageUrl, fanpageLabel } = buildContactViewModel();
  const url = new URL(fanpageUrl);

  assert.equal(fanpageLabel.startsWith("www."), false, "www. is not how a page's name is written");
  assert.equal(fanpageLabel, `${url.host.replace(/^www\./, "")}${url.pathname}`);
  assert.equal(fanpageLabel.includes(url.pathname.replace(/^\//, "")), true);
});
