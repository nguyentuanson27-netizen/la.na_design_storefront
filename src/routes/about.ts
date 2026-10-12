import { BRAND } from "@/brand";
import { buildAboutViewModel, type AboutViewModel } from "./evergreen-model.ts";
import { ABOUT_DESCRIPTION, ABOUT_FAQ } from "./about-copy.ts";
import { sealRoute, type RouteHandle } from "./core.tsx";

/** The About page's loader. Owner-approved brand story, legal facts and SEO/GEO structured data. */

export type AboutRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export async function loadAboutRoute(): Promise<RouteHandle<AboutViewModel>> {
  const origin = "https://www.lanadesign.vn";
  const aboutUrl = `${origin}/about`;

  const aboutPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: `Về ${BRAND.identity.name} | Thời Trang Nữ Thiết Kế & Áo Dài Cao Cấp Từ 2022`,
    description: ABOUT_DESCRIPTION,
    url: aboutUrl,
    mainEntity: {
      "@type": "Organization",
      name: BRAND.identity.name,
      alternateName: [BRAND.identity.searchAlias],
      url: origin,
      slogan: BRAND.identity.strapline,
      foundingDate: "2022",
      legalName: BRAND.identity.legalName,
      taxID: BRAND.identity.taxId,
      address: {
        "@type": "PostalAddress",
        streetAddress: BRAND.contact.streetAddress,
        addressLocality: BRAND.contact.addressLocality,
        addressCountry: "VN",
      },
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        telephone: BRAND.contact.telephoneInternational,
        email: BRAND.contact.email,
      },
      sameAs: [
        BRAND.contact.fanpageUrl,
        BRAND.contact.instagramUrl,
        BRAND.contact.tiktokUrl,
      ].filter(Boolean),
    },
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ABOUT_FAQ.map(({ question, answer }) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  };

  const breadcrumbsJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Trang chủ",
        item: origin,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: `Về ${BRAND.identity.name}`,
        item: aboutUrl,
      },
    ],
  };

  return sealRoute({
    data: buildAboutViewModel(),
    refreshAfterMs: 60_000,
    trackingEvent: null,
    structuredData: [aboutPageJsonLd, faqJsonLd, breadcrumbsJsonLd],
    pixelEvents: [],
  });
}
