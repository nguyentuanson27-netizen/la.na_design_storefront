import assert from "node:assert/strict";
import test from "node:test";

import { BRAND, FULFILLMENT } from "../../src/brand/index.ts";
import {
  describeGuestShippingPromotion,
  readGuestShippingPolicy,
} from "../../src/commerce/guest-shipping-policy.ts";
import {
  describePublicAddress,
  describePublicDeliveryEstimate,
  describePublicExchangeFee,
  describePublicRefundWindow,
  describePublicReturnWindow,
  describePublicSizeTolerance,
  describePublicSupportHours,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_DELIVERY_FACTS,
  PUBLIC_LEGAL_FACTS,
  PUBLIC_RETURNS_POLICY,
  PUBLIC_SIZE_GUIDE,
} from "../../src/content/public-brand-facts.ts";
import {
  buildAboutViewModel,
  buildContactViewModel,
  buildReturnsViewModel,
  buildShippingViewModel,
  buildSizeGuideViewModel,
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

/* --------------------------------------------------------------------------- shipping */

const shipping = () => buildShippingViewModel({ policy: readGuestShippingPolicy() });

test("Shipping names the owner-approved Hanoi scopes, not the ambiguous historical labels", () => {
  const model = shipping();

  assert.equal(model.innerCityLabel, FULFILLMENT.deliveryScopeLabels.innerCity);
  assert.equal(model.otherProvinceLabel, FULFILLMENT.deliveryScopeLabels.otherProvince);
  // The historical labels were the bare "Nội thành" and "Ngoại tỉnh", which name no city and so
  // mean whatever the reader assumes. The approved ones say Hanoi; what is pinned is that the page
  // never falls back to the bare pair.
  assert.notEqual(model.innerCityLabel, "Nội thành");
  assert.notEqual(model.otherProvinceLabel, "Ngoại tỉnh");
  assert.equal(model.innerCityLabel.includes("Hà Nội"), true);
  assert.equal(model.otherProvinceLabel.includes("Hà Nội"), true);
});

test("Shipping's delivery estimates come from the delivery facts through the shared helper", () => {
  const model = shipping();

  assert.equal(
    model.innerCityEstimate,
    describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.innerCity),
  );
  assert.equal(
    model.otherProvinceEstimate,
    describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.otherProvince),
  );
  assert.equal(model.carriersText, PUBLIC_DELIVERY_FACTS.carriers.join(" · "));
});

test("Shipping's fee wording follows the server's own policy", () => {
  // The page states what checkout will charge. A number written into markup would be a second
  // authority on shipping price, free to disagree with the one that actually applies.
  const policy = readGuestShippingPolicy();
  const promotion = describeGuestShippingPromotion(policy);
  const model = buildShippingViewModel({ policy });

  assert.equal(model.shippingPromotionTitle, promotion.title);
  assert.equal(model.shippingPromotionDetail, promotion.detail);
});

test("Shipping's fee wording tracks a changed policy rather than a captured one", () => {
  // Guards the guard above: if the model read the ambient policy instead of its argument, both
  // would still agree and the previous test would pass.
  const low = buildShippingViewModel({
    policy: { ...readGuestShippingPolicy(), freeShippingSubtotalVnd: 300_000 },
  });
  const high = buildShippingViewModel({
    policy: { ...readGuestShippingPolicy(), freeShippingSubtotalVnd: 900_000 },
  });

  assert.notEqual(low.shippingPromotionDetail, high.shippingPromotionDetail);
});

/* ---------------------------------------------------------------------------- returns */

test("Returns states the policy's windows and fees, never its own numbers", () => {
  const model = buildReturnsViewModel();

  assert.equal(model.returnWindow, describePublicReturnWindow());
  assert.equal(model.refundWindow, describePublicRefundWindow());
  assert.equal(model.exchangeFee, describePublicExchangeFee());
});

test("Returns passes the reviewed clause lists through untouched", () => {
  const model = buildReturnsViewModel();

  assert.deepEqual(model.productConditions, PUBLIC_RETURNS_POLICY.productConditions);
  assert.deepEqual(model.supportedCases, PUBLIC_RETURNS_POLICY.supportedCases);
  assert.equal(model.productConditions.length > 0, true, "the policy is not vacuously empty");
});

test("Returns carries the later owner-approved return logistics", () => {
  const model = buildReturnsViewModel();
  const { returnMethods, restockingFeeNote, nonDefectiveRefundNote } = FULFILLMENT.returnLogistics;

  assert.equal(model.returnInStore, returnMethods.inStore);
  assert.equal(model.returnByMail, returnMethods.byMail);
  assert.equal(model.returnByMailResponsibility, returnMethods.byMailResponsibility);
  assert.equal(model.restockingFeeNote, restockingFeeNote);
  assert.equal(model.nonDefectiveRefundNote, nonDefectiveRefundNote);
});

/* ------------------------------------------------------------------------- size guide */

test("the Size Guide passes every approved chart through whole", () => {
  const model = buildSizeGuideViewModel();

  // Whole rather than reshaped: a brand adding a third table gets a third table and nothing else
  // has to change. Reshaping here is where a dropped row or a reordered size scale would come from.
  assert.deepEqual(model.charts, PUBLIC_SIZE_GUIDE.charts);
  assert.equal(model.charts.length > 0, true, "the guide is not vacuously empty");
});

test("the Size Guide states the approved unit, tolerance and notes and derives no fit advice", () => {
  const model = buildSizeGuideViewModel();

  assert.equal(model.unit, PUBLIC_SIZE_GUIDE.unit);
  assert.equal(model.toleranceNote, PUBLIC_SIZE_GUIDE.toleranceNote);
  assert.equal(model.toleranceText, describePublicSizeTolerance());
  assert.equal(model.circumferenceSemanticsNote, PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote);
  assert.equal(model.guidanceNote, PUBLIC_SIZE_GUIDE.guidanceNote);

  // B3 approved the tables and nothing else. A recommended size, a fit vocabulary or a
  // measurement-to-size mapping appearing here would be a fit claim this repository invented.
  assert.deepEqual(Object.keys(model).sort(), [
    "charts",
    "circumferenceSemanticsNote",
    "guidanceNote",
    "toleranceNote",
    "toleranceText",
    "unit",
  ]);
});

test("each chart's caption tolerance is the same one the intro states", () => {
  // Two wordings of one tolerance is how a page ends up publishing two tolerances.
  const model = buildSizeGuideViewModel();

  assert.equal(model.toleranceText.includes(String(PUBLIC_SIZE_GUIDE.toleranceCm)), true);
});
