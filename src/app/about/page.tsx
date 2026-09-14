import type { Metadata } from "next";
import Link from "next/link";

import {
  describePublicAddress,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_LEGAL_FACTS,
} from "@/content/public-brand-facts";
import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type AboutPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: AboutPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/about",
    searchParams: await searchParams,
    title: `Về ${BRAND.identity.name}`,
    description: PUBLIC_BRAND_POSITIONING,
  });
}

/**
 * W13/U33a — the minimal About page B6 approves, and deliberately no more than that.
 *
 * B6 resolved "for a minimal About page": the brand positioning, the legal entity, the address and
 * the confirmed MST may be public; the founding year, the founder and any brand story or values are
 * withheld. This page therefore has no origin story, no mission statement and no team section — not
 * because they would not read well, but because no approved source states them and a coding agent
 * may not author a brand's history.
 *
 * The positioning sentence and the legal facts are read from the fact authority rather than written
 * here, so the one place they can change is the place the owner's decision is transcribed.
 */
export default function AboutPage() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Thương hiệu</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Về {BRAND.identity.name}
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8">{PUBLIC_BRAND_POSITIONING}</p>

      <section aria-labelledby="legal-heading" className="mt-16 border-t border-black/20 pt-10">
        <h2 id="legal-heading" className="font-serif text-3xl tracking-[-0.03em]">
          Thông tin pháp lý
        </h2>
        <dl className="mt-8 grid max-w-2xl gap-6 text-base leading-7">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Đơn vị chủ quản</dt>
            <dd className="mt-2 text-black/70">{PUBLIC_LEGAL_FACTS.legalEntityName}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Mã số thuế</dt>
            <dd className="mt-2 text-black/70">{PUBLIC_LEGAL_FACTS.taxCode}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Địa chỉ</dt>
            <dd className="mt-2 text-black/70">{describePublicAddress()}</dd>
          </div>
        </dl>
      </section>

      <p className="mt-12 max-w-2xl text-sm leading-6 text-black/65">
        Cần hỗ trợ?{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/contact"
        >
          Liên hệ {BRAND.identity.name}
        </Link>
        .
      </p>
    </div>
  );
}
