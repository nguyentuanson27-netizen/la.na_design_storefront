import assert from "node:assert/strict";
import test from "node:test";

import { describeGuestShippingPromotion } from "../../src/commerce/guest-shipping-policy.ts";
import { normalizeVietnamesePhone } from "../../src/integrations/meta/conversions-api.ts";
import {
  buildPublicBrandFacts,
  describePublicDeliveryEstimate,
  describePublicExchangeFee,
  describePublicRefundWindow,
  describePublicReturnWindow,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_DELIVERY_FACTS,
  PUBLIC_LEGAL_FACTS,
  PUBLIC_RETURNS_POLICY,
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
  supportHoursSchemaTime,
  PUBLIC_SIZE_GUIDE,
  describePublicSizeTolerance,
} from "../../src/content/public-brand-facts.ts";

test("P16A public brand facts expose only approved identity and commerce facts", () => {
  const policy = {
    feeVnd: 25_000,
    freeShippingSubtotalVnd: 750_000,
    freeShippingMinQuantity: 4,
  } as const;

  const facts = buildPublicBrandFacts(policy);

  assert.deepEqual(facts, {
    brandName: "La.na Design",
    brandSummary: "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ",
    paymentMethod: "Thanh toán khi nhận hàng (COD).",
    checkoutAccount: "Không cần tài khoản để thanh toán.",
    shipping: describeGuestShippingPromotion(policy),
    orderTracking: {
      title: "Tra cứu đơn hàng",
      detail:
        "Tra cứu trạng thái đơn COD bằng mã đơn và số điện thoại đã dùng khi đặt hàng.",
    },
    serverVerification:
      "Giá, tồn kho và phí vận chuyển được máy chủ kiểm tra lại khi bạn đặt hàng.",
  });

  for (const unsupportedClaim of ["material", "fit", "origin", "returnPolicy"]) {
    assert.equal(unsupportedClaim in facts, false, unsupportedClaim);
  }
});

/**
 * U32b / B2. These are the contact facts the owner approved in
 * `docs/specs/la-clothing-owner-approved-facts-and-decisions.md` §2, transcribed exactly. The test
 * is a transcription check, not a formatting preference: the Organization entity and, later, the
 * Contact page both read this constant, so a typo here would publish a wrong phone number on the
 * storefront and in structured data at once.
 */
test("U32b public contact facts transcribe the approved B2 source exactly", () => {
  assert.deepEqual(PUBLIC_CONTACT_FACTS, {
    telephone: "0923159666",
    telephoneInternational: "+84923159666",
    email: "la.nadesignsince2022@gmail.com",
    fanpageUrl: "https://www.facebook.com/la.nadesign.vn",
    streetAddress: "212 Nguyễn Trãi, Đại Mỗ",
    addressLocality: "Hà Nội",
    supportHours: {
      // "hằng ngày" is part of the approved statement, so it lives with the times rather than
      // being re-stated by each consumer. A reader of this constant gets the whole fact.
      days: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      opens: "08:00",
      closes: "22:00",
      utcOffset: "+07:00",
      utcOffsetLabel: "UTC+7",
    },
  });

  assert.equal(Object.isFrozen(PUBLIC_CONTACT_FACTS), true);
  assert.equal(Object.isFrozen(PUBLIC_CONTACT_FACTS.supportHours), true);
  assert.equal(Object.isFrozen(PUBLIC_CONTACT_FACTS.supportHours.days), true);
});

test("U32b the two views of the approved facts are derived from the same parts", () => {
  // Schema.org wants an ISO time carrying the offset; a reader wants a sentence. Both come from
  // the constant, so the footer and the JSON-LD cannot state different hours.
  assert.equal(supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.opens), "08:00:00+07:00");
  assert.equal(supportHoursSchemaTime(PUBLIC_CONTACT_FACTS.supportHours.closes), "22:00:00+07:00");

  assert.equal(describePublicSupportHours(), "08:00 - 22:00 hằng ngày (UTC+7)");
  assert.equal(describePublicAddress(), "212 Nguyễn Trãi, Đại Mỗ, Hà Nội");

  // The sentence is built from the parts, not typed out beside them.
  for (const part of [
    PUBLIC_CONTACT_FACTS.supportHours.opens,
    PUBLIC_CONTACT_FACTS.supportHours.closes,
    PUBLIC_CONTACT_FACTS.supportHours.utcOffsetLabel,
  ]) {
    assert.equal(describePublicSupportHours().includes(part), true, part);
  }
  for (const part of [PUBLIC_CONTACT_FACTS.streetAddress, PUBLIC_CONTACT_FACTS.addressLocality]) {
    assert.equal(describePublicAddress().includes(part), true, part);
  }
});

/**
 * The two spellings of the approved number are one fact. Google's Organization guidance wants the
 * country code on `contactPoint.telephone`, and the calling code comes from O2 — the owner decision
 * that the country/market is Việt Nam — not from the address.
 *
 * This checks the international form against the repository's existing reviewed Vietnamese phone
 * normalization rather than restating it, so a typo in either spelling fails here instead of
 * publishing a number nobody can reach. That function is imported by the test only: it exists to
 * collapse free-text buyer input for hashing, which is a different contract from rendering a
 * canonical published identifier, and the two must not become one authority by accident.
 */
test("U32b the international telephone is the approved number with the approved country code", () => {
  assert.equal(
    PUBLIC_CONTACT_FACTS.telephoneInternational,
    `+${normalizeVietnamesePhone(PUBLIC_CONTACT_FACTS.telephone)}`,
  );

  // Same subscriber digits either way: the trunk zero is replaced, nothing is invented.
  assert.equal(
    PUBLIC_CONTACT_FACTS.telephoneInternational.replace("+84", ""),
    PUBLIC_CONTACT_FACTS.telephone.replace(/^0/, ""),
  );
});

test("U32b carries no fact outside the B2 contact contract", () => {
  // `legalEntity`/`taxCode` are **not** owner-blocked — B6 approves publishing the legal entity and
  // the confirmed MST. They are simply outside the B2 contact contract this constant owns, and
  // belong to the About/legal surface U33 builds. The rest have no approved source at all: no logo
  // asset, no postal country, no Zalo profile URL, and B6 does keep founder/founding year private.
  for (const unapproved of [
    "logo",
    "legalEntity",
    "taxCode",
    "vatID",
    "foundingDate",
    "founder",
    "addressCountry",
    "postalCode",
    "zaloUrl",
  ]) {
    assert.equal(unapproved in PUBLIC_CONTACT_FACTS, false, unapproved);
  }
});

/**
 * U33a / B6. The About page publishes exactly what §1 and §7 approve and nothing more.
 *
 * B6 is the decision most likely to be widened by accident: the owner approved a positioning
 * sentence, the legal entity and the confirmed MST, and explicitly withheld the founding year, the
 * founder and any brand story. A page written from prose rather than from this constant is how an
 * invented history reaches the storefront, so the facts are transcribed here once and asserted
 * against §1/§7 word for word.
 */
test("U33a the approved brand positioning is the owner's sentence, not a paraphrase", () => {
  assert.equal(
    PUBLIC_BRAND_POSITIONING,
    "La.na Design là thương hiệu thời trang nữ thiết kế, tập trung vào áo dài, váy và set đồ với phong cách thanh lịch, nữ tính",
  );
});

test("U33a / A2 the approved legal facts transcribe the registered identity, and own no business address", () => {
  assert.deepEqual(PUBLIC_LEGAL_FACTS, {
    legalEntityName: "CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS",
    taxCode: "0111242251",
    taxIdIssueDate: "7/10/2025",
    registeredAddress:
      "Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công",
    legalEmail: "congtytnhh.las@gmail.com",
  });

  // A2 widened this to the whole registered identity, not to the customer-facing contact. The
  // business/return address and the support inbox stay contact facts, published under their own
  // labels through PUBLIC_CONTACT_FACTS, so a legal block cannot quietly become a returns address.
  const legal = PUBLIC_LEGAL_FACTS as Record<string, unknown>;
  for (const contactOwned of ["streetAddress", "addressLocality", "email", "telephone"]) {
    assert.equal(contactOwned in legal, false, contactOwned);
  }
  assert.notEqual(PUBLIC_LEGAL_FACTS.registeredAddress, describePublicAddress());

  assert.equal(Object.isFrozen(PUBLIC_LEGAL_FACTS), true);
});

test("U33a carries no About fact B6 withheld", () => {
  const legal = PUBLIC_LEGAL_FACTS as Record<string, unknown>;
  // B6 withholds these outright: no founding year, no founder, no brand story or values beyond the
  // current positioning sentence. A coding agent may not author any of them.
  for (const withheld of [
    "foundingYear",
    "foundedAt",
    "founder",
    "founders",
    "people",
    "brandStory",
    "mission",
    "values",
    "history",
  ]) {
    assert.equal(withheld in legal, false, withheld);
  }

  // The positioning sentence is the whole approved claim; nothing may be appended to it.
  assert.equal(/thành lập|founder|sứ mệnh|giá trị cốt lõi/i.test(PUBLIC_BRAND_POSITIONING), false);
});

/**
 * U33b / B1. Policy is the one kind of content a coding agent must never author, so every clause the
 * Returns page can show is asserted against §4 here — the whole condition list and the whole
 * supported-case list, not a sample. A page rendering these arrays cannot grow a clause the owner
 * never wrote without this test going red.
 */
test("U33b the returns policy transcribes §4 clause for clause", () => {
  assert.deepEqual(PUBLIC_RETURNS_POLICY, {
    windowDays: 15,
    productConditions: [
      "còn mới",
      "chưa qua sử dụng",
      "còn đầy đủ tem/mác",
      "không rách, bẩn, hư hỏng",
      "không có mùi lạ",
      "không có dấu hiệu đã qua sử dụng",
      "đúng sản phẩm được mua từ La.na Design",
      "gửi lại theo hướng dẫn của bộ phận hỗ trợ",
    ],
    supportedCases: [
      "Sản phẩm lỗi hoặc có vết bẩn từ phía sản xuất.",
      "La.na Design giao sai mẫu.",
      "Giao sai màu.",
      "Giao sai size.",
      "Khách hàng chủ động đổi sang mẫu khác.",
      "Khách hàng mua đúng hàng nhưng muốn đổi size hoặc đổi màu.",
    ],
    customerInitiatedExchangeFeeVnd: 50_000,
    // Who bears the shipping in each case is a normative B1 commitment. Held here rather than in
    // page prose, so the constant matching §4 and the page saying the same thing are one fact.
    customerInitiatedShippingNote: "Khách hàng chịu phí vận chuyển hai chiều.",
    shopFaultShippingNote: "La.na Design chịu toàn bộ phí vận chuyển hợp lý cho việc đổi/trả.",
    // §4 states there is no separate excluded-category list. Empty is the decision, not a gap, and
    // the note is what that emptiness means — the page renders the state rather than asserting it.
    nonReturnableCategories: [],
    nonReturnableCategoriesNote:
      "Không có danh mục sản phẩm loại trừ riêng. La.na Design chỉ áp dụng các điều kiện từ chối đã nêu trong chính sách này.",
    refundWorkingDays: { minimum: 7, maximum: 10 },
    refundChannelNote:
      "Hoàn tiền cho đơn COD có thể thực hiện qua chuyển khoản ngân hàng hoặc phương thức phù hợp được thống nhất với khách hàng.",
  });

  // Intl's vi-VN currency form puts a non-breaking space before the symbol; pinned explicitly so
  // the expectation cannot drift into an ordinary space that only looks the same.
  assert.equal(describePublicExchangeFee(), "50.000\u00a0₫ / sản phẩm");

  // Both windows carry the semantics a buyer argues about, not just the number: when the return
  // window starts, and which event starts the refund clock. Left in page prose those could drift
  // from §4 while the numeric fields still matched it.
  assert.equal(describePublicReturnWindow(), "15 ngày kể từ ngày khách hàng nhận hàng");
  assert.equal(
    describePublicRefundWindow(),
    "7–10 ngày làm việc kể từ khi La.na Design nhận lại sản phẩm, kiểm tra và xác nhận đủ điều kiện hoàn tiền",
  );
});

test("U33b the delivery facts transcribe §5 and hold no shipping price", () => {
  assert.deepEqual(PUBLIC_DELIVERY_FACTS, {
    coverage: "Giao hàng toàn quốc",
    carriers: ["GHN", "GHTK"],
    estimateDays: {
      innerCity: { minimum: 1, maximum: 3 },
      otherProvince: { minimum: 3, maximum: 15 },
    },
    estimateCaveat: "Đây là thời gian dự kiến, không phải cam kết thời hạn tuyệt đối.",
    // Stored as the sentence the page renders, not as a boolean beside hard-coded copy: a flag no
    // rendering reads is how a fact changes here while the page keeps saying the old thing.
    carrierTrackingNote:
      "La.na Design không cung cấp mã vận đơn hoặc link theo dõi của đơn vị vận chuyển theo mặc định.",
    phoneConfirmationWording: "La.na Design có thể liên hệ để xác minh đơn hàng khi cần.",
  });

  // B4 keeps the server-owned policy as the pricing authority, because production may legitimately
  // override it. A fee copied here is how a policy page starts contradicting checkout.
  const delivery = PUBLIC_DELIVERY_FACTS as Record<string, unknown>;
  for (const priceKey of [
    "feeVnd",
    "shippingFeeVnd",
    "freeShippingSubtotalVnd",
    "freeShippingMinQuantity",
  ]) {
    assert.equal(priceKey in delivery, false, priceKey);
  }

  assert.equal(describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.innerCity), "1–3 ngày");
  assert.equal(
    describePublicDeliveryEstimate(PUBLIC_DELIVERY_FACTS.estimateDays.otherProvince),
    "3–15 ngày",
  );
});

test("U33b payment facts stay with the builder that already owned them", () => {
  // `buildPublicBrandFacts` owned the payment method, the no-account fact and the server
  // re-verification sentence before /shipping existed, and the footer renders them. U33b reuses it
  // rather than adding a second representation of the same public facts.
  const facts = buildPublicBrandFacts({
    feeVnd: 25_000,
    freeShippingSubtotalVnd: 750_000,
    freeShippingMinQuantity: 4,
  }) as Record<string, unknown>;
  assert.equal(facts.paymentMethod, "Thanh toán khi nhận hàng (COD).");
  assert.equal(facts.checkoutAccount, "Không cần tài khoản để thanh toán.");

  // §3 forbids publishing transfer, card or wallet as a checkout method while checkout does not
  // support them. Bank transfer may be named as a refund channel, never as a way to pay.
  const paymentMethod = String(facts.paymentMethod);
  for (const unsupported of [/thẻ tín dụng/i, /ví điện tử/i, /momo/i, /vnpay/i, /chuyển khoản/i]) {
    assert.equal(unsupported.test(paymentMethod), false, unsupported.source);
  }
  assert.equal(/chuyển khoản/i.test(PUBLIC_RETURNS_POLICY.refundChannelNote), true);
});

/**
 * U33c / B3. The owner approved two size charts, centimetres, circumference semantics, a ±3 cm
 * tolerance, and guidance-only height/weight references. Measurements, size vocabulary, and fit
 * claims beyond these approved facts must never be authored or derived.
 */
test("U33c the size guide authority transcribes B3 exactly", () => {
  assert.deepEqual(PUBLIC_SIZE_GUIDE, {
    unit: "cm",
    toleranceCm: 3,
    circumferenceSemanticsNote:
      "Rộng ngực, Rộng eo, Rộng mông là số đo vòng quanh sản phẩm, không phải chiều ngang khi trải phẳng.",
    toleranceNote: "Dung sai sai số may mặc: ±3 cm.",
    guidanceNote:
      "Thông số chiều cao và cân nặng mang tính chất tham khảo chọn size, không bảo đảm vừa vặn tuyệt đối cho mọi vóc dáng.",
    // The fixed chartA/chartB pair became a list of charts, each carrying its own size scale. The
    // approved B3 numbers and titles are unchanged; only the shape holding them is.
    charts: [
      {
        id: "relaxed-and-elastic-waist",
        title: "Sản phẩm dáng rộng / quần lưng chun",
        sizes: ["M", "L", "XL", "2XL"],
        rows: [
          {
            parameter: "Rộng ngực (vòng, cm)",
            values: { M: "106", L: "110", XL: "114", "2XL": "118" },
          },
          {
            parameter: "Dài tay (cm)",
            values: { M: "55", L: "56", XL: "57", "2XL": "58" },
          },
          {
            parameter: "Dài áo (cm)",
            values: { M: "63.5", L: "65.5", XL: "67.5", "2XL": "69.5" },
          },
          {
            parameter: "Dài quần (cm)",
            values: { M: "105", L: "106", XL: "107", "2XL": "108" },
          },
          {
            parameter: "Rộng eo — chun (vòng, cm)",
            values: { M: "70–80", L: "74–84", XL: "78–88", "2XL": "82–92" },
          },
          {
            parameter: "Rộng mông (vòng, cm)",
            values: { M: "108", L: "112", XL: "116", "2XL": "120" },
          },
          {
            parameter: "Chiều cao tham khảo",
            values: { M: "1m60–1m85", L: "1m60–1m85", XL: "1m60–1m85", "2XL": "1m60–1m85" },
          },
          {
            parameter: "Cân nặng tham khảo (kg)",
            values: { M: "50–59", L: "60–69", XL: "70–79", "2XL": "80–89" },
          },
        ],
      },
      {
        id: "short-sleeve-tops",
        title: "Áo ngắn tay",
        sizes: ["M", "L", "XL", "2XL"],
        rows: [
          {
            parameter: "Rộng ngực (vòng, cm)",
            values: { M: "120", L: "124", XL: "128", "2XL": "132" },
          },
          {
            parameter: "Dài áo (cm)",
            values: { M: "63", L: "65", XL: "67", "2XL": "69" },
          },
          {
            parameter: "Dài tay (cm)",
            values: { M: "27", L: "28", XL: "29", "2XL": "30" },
          },
          {
            parameter: "Chiều cao tham khảo",
            values: { M: "1m60–1m85", L: "1m60–1m85", XL: "1m60–1m85", "2XL": "1m60–1m85" },
          },
          {
            parameter: "Cân nặng tham khảo (kg)",
            values: { M: "50–59", L: "60–69", XL: "70–79", "2XL": "80–89" },
          },
        ],
      },
    ],
  });

  assert.equal(describePublicSizeTolerance(), "±3 cm");

  // Negative assertions on authority notes: no guarantee claims
  for (const forbidden of [/đảm bảo vừa/i, /fit guaranteed/i, /chắc chắn vừa/i, /cam kết vừa/i]) {
    assert.equal(forbidden.test(PUBLIC_SIZE_GUIDE.guidanceNote), false);
    assert.equal(forbidden.test(PUBLIC_SIZE_GUIDE.toleranceNote), false);
    assert.equal(forbidden.test(PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote), false);
  }
});

