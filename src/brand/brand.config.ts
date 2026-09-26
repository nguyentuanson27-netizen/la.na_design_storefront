import { MARKET_VN, type BrandConfig } from "./schema.ts";

/**
 * The brand facts this storefront publishes.
 *
 * Every value here traces to a row in
 * `docs/specs/la-na-design-owner-approved-facts-and-decisions.md`, which is the field-by-field view
 * of the owner-approved master spec. Brand Config is a home for those facts, not a licence to write
 * freely about the brand — no page may state a brand fact that is not here, and no fact may be
 * added here that the owner has not approved.
 */
export const BRAND: BrandConfig = {
  // Owner-facts §2, master spec §5.
  identity: {
    name: "La.na Design",
    // Not a mistake and not a missing transform: the field name is inherited from the template, and
    // the approved wordmark is this exact casing. An uppercased form would be a second spelling.
    displayNameUpper: "La.na Design",
    headline: "La.na Design - charismatic in every yard of cloth.",
    tagline: "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ",
    strapline: "Charismatic in every yard of cloth.",
    // Owner-facts §3b legal identity, approved for publication.
    legalName: "CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS",
    taxId: "0111242251",
    // One approved sentence, word for word. The owner withheld the founding year, the founder and
    // any brand story beyond it.
    positioning:
      "La.na Design là thương hiệu thời trang nữ thiết kế, tập trung vào áo dài, váy và set đồ với phong cách thanh lịch, nữ tính",
    // Project identity, not an owner brand fact: `bootstrap:brand` renames the social
    // card route to `<projectSlug>-social-card.png`, and brand-leak.test.ts asserts this value
    // still names that directory. It therefore moves with project.config.json, not with the brand.
    socialCardSlug: "la-na-design-social-card",
    socialCardAlt: "La.na Design - Thời trang nữ thiết kế thanh lịch, nữ tính",
    // The homepage's own approved metadata, distinct from the inherited headline/tagline above.
    homeTitle: "La.na Design | Áo dài & Thời trang nữ thiết kế",
    homeMetaDescription:
      "La.na Design - thời trang nữ thiết kế với áo dài cách tân, áo dài Tết, áo dài cưới, áo dài 4 tà, áo dài 6 tà, váy, set đồ và phụ kiện.",
    // Master spec §23, quoted exactly. Body copy for the homepage brand story, not a rewrite of
    // the tagline or the meta description above.
    homeBrandStory:
      "La.na Design mang đến những thiết kế thời trang nữ thanh lịch, nữ tính, với điểm nhấn là áo dài, váy và set đồ được chọn lọc kĩ lưỡng và tỉ mỉ.",
    // Approved for search matching and natural SEO copy only. The public display name stays
    // "La.na Design", and no doorway page may be built for the spelling variant.
    searchAlias: "Lana Design",
    // Empty because both approved spellings clear the leak scanner's four-character floor on their
    // own. A brand with a two or three character name declares it here so the scanner protects it.
    additionalNeedles: [],
  },
  // Owner-facts §3 — the customer-facing business/support contact, distinct from `legal` below.
  // `telephone` and `telephoneInternational` are the same approved number written two ways; the
  // loader pins the derivation against normalizeVietnamesePhone.
  contact: {
    telephone: "0923159666",
    telephoneInternational: "+84923159666",
    email: "la.nadesignsince2022@gmail.com",
    fanpageUrl: "https://www.facebook.com/la.nadesign.vn",
    // Owner-supplied 2026-09-24 for the footer's social icons.
    instagramUrl: "https://www.instagram.com/la.nadesign.vn/",
    tiktokUrl: "https://www.tiktok.com/@la.nadesign.vn",
    // Owner-supplied 2026-09-26: the Pancake website Chat Plugin replaces the Messenger button.
    pancakeChatPageId: "web_lanadesign",
    streetAddress: "212 Nguyễn Trãi, Đại Mỗ",
    addressLocality: "Hà Nội",
    supportHours: {
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: "08:00",
      closes: "22:00",
      utcOffset: "+07:00",
      utcOffsetLabel: "UTC+7",
    },
  },
  /**
   * Owner-facts §3b — the registered legal entity's own contact facts, approved for the About/legal
   * surface.
   *
   * Deliberately not merged into `contact`: the registered office is not the return address and the
   * corporate mailbox is not the support inbox, so one shared pair could only hold one of each. The
   * entity name and MST stay in `identity`, where they were already published; the public
   * projection joins the two halves.
   *
   * The legal representative was withheld until the owner released it for the footer's legal
   * block (owner-facts §3b). Kept in the source's own casing: it is a transcription of a
   * registration document, not a display string this file is free to title-case.
   */
  legal: {
    registeredAddress:
      "Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công",
    email: "congtytnhh.las@gmail.com",
    // As the registration source states it: day/month/year, so this is 7 October 2025.
    taxIdIssueDate: "7/10/2025",
    legalRepresentative: "ĐINH THÙY LINH",
  },
  // ADR 0007 section 1, updated by owner-facts §4 — the approved Merchant shop defaults. La.na
  // Design is a women's fashion brand, so the category default is female rather than the
  // template's inherited menswear default.
  merchant: {
    feedBrand: "La.na Design",
    defaultGender: "female",
    defaultAgeGroup: "adult",
  },
  market: MARKET_VN,
};
