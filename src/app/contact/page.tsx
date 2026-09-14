import type { Metadata } from "next";
import Link from "next/link";

import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
} from "@/content/public-brand-facts";
import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type ContactPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: ContactPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/contact",
    searchParams: await searchParams,
    title: "Liên hệ",
    description:
      `Hotline, Zalo, email, địa chỉ và giờ hỗ trợ của ${BRAND.identity.name} — các kênh liên hệ chính thức.`,
  });
}

/**
 * W13/U33a — the evergreen Contact page.
 *
 * Every fact here is read from `PUBLIC_CONTACT_FACTS`, the same authority the site footer renders
 * and the `Organization` structured data marks up. Nothing is transcribed a second time: a phone
 * number that appears in three places and is owned by one constant cannot go stale in two of them.
 *
 * The page claims no support channel the owner did not approve. There is no contact form, no live
 * chat and no response-time promise, because none of those exist as an owner-approved fact and a
 * page that implies them would be a policy this repository invented.
 */
export default function ContactPage() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Hỗ trợ</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Liên hệ
      </h1>
      <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
        Các kênh liên hệ chính thức của {BRAND.identity.name}. Đội ngũ hỗ trợ trả lời trong giờ làm việc bên
        dưới.
      </p>

      <dl className="mt-12 grid max-w-2xl gap-8 text-base leading-7">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Hotline &amp; Zalo</dt>
          <dd className="mt-2">
            <a
              className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
              href={`tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}`}
            >
              {PUBLIC_CONTACT_FACTS.telephone}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Email</dt>
          <dd className="mt-2">
            <a
              className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
              href={`mailto:${PUBLIC_CONTACT_FACTS.email}`}
            >
              {PUBLIC_CONTACT_FACTS.email}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Địa chỉ</dt>
          <dd className="mt-2 text-black/70">{describePublicAddress()}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Giờ hỗ trợ</dt>
          <dd className="mt-2 text-black/70">{describePublicSupportHours()}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Fanpage</dt>
          <dd className="mt-2">
            <a
              className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
              href={PUBLIC_CONTACT_FACTS.fanpageUrl}
              rel="noreferrer"
              target="_blank"
            >
              facebook.com/LAclothing.vn
            </a>
          </dd>
        </div>
      </dl>

      <p className="mt-12 max-w-2xl text-sm leading-6 text-black/65">
        Cần tra cứu một đơn hàng đã đặt?{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/track-order"
        >
          Tra cứu đơn hàng
        </Link>{" "}
        bằng mã đơn và số điện thoại đã dùng khi đặt.
      </p>
    </div>
  );
}
