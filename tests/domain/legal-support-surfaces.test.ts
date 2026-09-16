import assert from "node:assert/strict";
import test from "node:test";

import { BRAND, FULFILLMENT } from "../../src/brand/index.ts";
import {
  describePublicAddress,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../../src/content/public-brand-facts.ts";
import { buildAboutViewModel, buildContactViewModel } from "../../src/routes/evergreen-model.ts";

/**
 * A7a — the About and Contact surfaces publish the registered legal identity and the customer
 * support channels as two separate things.
 *
 * A2 gave the registered address and the corporate mailbox their own typed home; this is where a
 * reader finally sees them, and the failure mode it guards is the one that matters: a page that
 * shows the registered office under a heading a customer reads as "where to send a return", or the
 * corporate mailbox under one they read as "where to ask about my order". Both are correct strings
 * in the wrong role, which no spell-check and no leak scanner would catch.
 */

test("A7a About publishes the registered legal identity, and the two addresses keep their roles", () => {
  const about = buildAboutViewModel();

  assert.equal(about.legalEntityName, PUBLIC_LEGAL_FACTS.legalEntityName);
  assert.equal(about.taxCode, PUBLIC_LEGAL_FACTS.taxCode);
  assert.equal(about.taxIdIssueDate, PUBLIC_LEGAL_FACTS.taxIdIssueDate);
  assert.equal(about.registeredAddress, PUBLIC_LEGAL_FACTS.registeredAddress);
  assert.equal(about.legalEmail, PUBLIC_LEGAL_FACTS.legalEmail);

  // The business address is still published, under its own name.
  assert.equal(about.businessAddress, describePublicAddress());
});

test("A7a the legal and business roles cannot be swapped without the model changing", () => {
  const about = buildAboutViewModel();
  const contact = buildContactViewModel();

  // Distinct values under distinct names, on both surfaces.
  assert.notEqual(about.registeredAddress, about.businessAddress);
  assert.notEqual(about.legalEmail, PUBLIC_CONTACT_FACTS.email);
  assert.notEqual(contact.businessAddress, PUBLIC_LEGAL_FACTS.registeredAddress);
  assert.notEqual(contact.email, PUBLIC_LEGAL_FACTS.legalEmail);

  // A reader's route to each fact is the role, not the value: the registered office comes from the
  // legal projection and the return address from the contact one, so a later edit that crossed them
  // would have to cross the projections too.
  assert.equal(about.registeredAddress, BRAND.legal.registeredAddress);
  assert.equal(about.legalEmail, BRAND.legal.email);
  assert.equal(contact.businessAddress, describePublicAddress());
  assert.equal(contact.email, BRAND.contact.email);
});

test("A7a no legal representative reaches either surface", () => {
  for (const model of [
    buildAboutViewModel() as Record<string, unknown>,
    buildContactViewModel() as Record<string, unknown>,
  ]) {
    for (const withheld of [
      "legalRepresentative",
      "representative",
      "representativeName",
      "nguoiDaiDien",
      "director",
      "owner",
    ]) {
      assert.equal(withheld in model, false, withheld);
    }
  }
});

test("A7a Contact publishes the approved support channels and the complaint response target", () => {
  const contact = buildContactViewModel();

  assert.equal(contact.telephone, "0923159666");
  assert.equal(contact.telephoneInternational, "+84923159666");
  assert.equal(contact.email, "la.nadesignsince2022@gmail.com");
  assert.equal(contact.fanpageUrl, "https://www.facebook.com/la.nadesign.vn");
  assert.match(contact.supportHours, /08:00 - 22:00/);
  assert.match(contact.supportHours, /hằng ngày/);

  // §15's response target is a commitment, so it arrives from the policy authority rather than
  // being phrased by the page.
  assert.equal(contact.complaintResponse, FULFILLMENT.support.complaintResponseNote);
});

test("A7a neither surface invents a channel, a promise or a Brand #1 placeholder", () => {
  const published = JSON.stringify([buildAboutViewModel(), buildContactViewModel()]);

  for (const stale of ["LA Clothing", "laclothing", "menswear", "example.com", "TODO", "TBD", "XXX"]) {
    assert.equal(published.includes(stale), false, stale);
  }
  // The contact form's delivery is G3/F9b work. Until then no surface may claim a message was sent
  // or promise a live channel that does not exist.
  for (const invented of [/live chat/i, /đã gửi thành công/i, /hotline 24\/7/i, /zalo\.me/i]) {
    assert.equal(invented.test(published), false, invented.source);
  }
});
