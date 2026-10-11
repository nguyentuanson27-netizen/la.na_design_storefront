import { BRAND } from "@/brand";
import { buildAboutViewModel, type AboutViewModel } from "./evergreen-model.ts";
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
    description:
      "Thành lập từ năm 2022, La.na Design là thương hiệu thời trang nữ thiết kế cao cấp, nổi bật với áo dài cách tân 4 tà, đầm tiệc và set đồ thanh lịch, tôn vinh nét duyên Việt.",
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
    mainEntity: [
      {
        "@type": "Question",
        name: "La.na Design thành lập năm nào và chuyên về dòng sản phẩm gì?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "La.na Design thành lập từ năm 2022, là thương hiệu thời trang nữ thiết kế cao cấp chuyên về các dòng áo dài cách tân 4 tà, đầm dự tiệc và set đồ thanh lịch dành cho phái đẹp.",
        },
      },
      {
        "@type": "Question",
        name: "Khách hàng có thể đến thử đồ trực tiếp ở đâu?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Quý khách có thể ghé thăm và trải nghiệm trực tiếp không gian thời trang tại Showroom La.na Design: 212 Nguyễn Trãi, Hà Nội (mở cửa từ 08:00 đến 22:00 hàng ngày).",
        },
      },
      {
        "@type": "Question",
        name: "Tôi mua hàng online từ xa thì làm sao để chọn được size vừa vặn?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Quý khách có thể trải nghiệm tính năng Thử đồ ảo AI ngay trên website, tham khảo bảng số đo chi tiết (ngực, eo, mông) hoặc nhắn tin trực tiếp qua hotline/Zalo 0923 159 666 để được chuyên viên tư vấn hỗ trợ chọn size chuẩn xác. La.na cũng áp dụng chính sách đổi size trong 15 ngày để nàng hoàn toàn yên tâm.",
        },
      },
    ],
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
        name: "Về La.na Design",
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
