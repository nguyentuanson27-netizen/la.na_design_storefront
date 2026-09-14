import { MARKET_VN, type BrandConfig } from "./schema.ts";

/**
 * The brand facts this storefront publishes.
 *
 * Inherited discipline, unchanged: every value here traces to
 * `docs/specs/la-clothing-owner-approved-facts-and-decisions.md`. Brand Config is a new home for
 * those facts, not a licence to write freely about the brand — no page may state a brand fact that
 * is not here, and no fact may be added here that the owner has not approved.
 */
export const BRAND: BrandConfig = {
  identity: {
    name: "LA Clothing",
    displayNameUpper: "LA CLOTHING",
    headline: "LA Clothing — Modern Menswear",
    tagline: "Minimal, modern menswear by LA Clothing.",
    // §1 legal identity, approved for publication by B6/§7.
    legalName: "CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS",
    taxId: "0111242251",
    // B6/§7, word for word. The owner withheld the founding year, the founder and any brand story
    // beyond this sentence.
    positioning: "LA Clothing là thương hiệu thời trang nam theo định hướng tối giản, hiện đại.",
    socialCardSlug: "la-clothing-modern-menswear-social-card",
    socialCardAlt: "LA Clothing — Modern Menswear",
    // Empty because "LA Clothing" clears the leak scanner's four-character floor on its own. A
    // brand with a two or three character name declares it here so the scanner still protects it.
    additionalNeedles: [],
  },
  // B2 §2 contact facts. `telephone` and `telephoneInternational` are the same approved number
  // written two ways; the loader pins the derivation against normalizeVietnamesePhone.
  contact: {
    telephone: "0923159666",
    telephoneInternational: "+84923159666",
    email: "laclothing2025@gmail.com",
    fanpageUrl: "https://www.facebook.com/LAclothing.vn",
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
  // ADR 0007 section 1 — the owner-approved Merchant shop defaults.
  merchant: {
    feedBrand: "LA Clothing",
    defaultGender: "male",
    defaultAgeGroup: "adult",
  },
  market: MARKET_VN,
};
