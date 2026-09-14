import type { Metadata } from "next";
import Link from "next/link";

import {
  describePublicSizeTolerance,
  PUBLIC_SIZE_GUIDE,
} from "@/content/public-brand-facts";
import { BRAND } from "@/brand";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type SizeGuidePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: SizeGuidePageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/size-guide",
    searchParams: await searchParams,
    title: "Hướng dẫn chọn size",
    description: `Bảng thông số chọn size quần áo ${BRAND.identity.name}, số đo vòng sản phẩm (${PUBLIC_SIZE_GUIDE.unit}), dung sai ${describePublicSizeTolerance()} và khoảng chiều cao, cân nặng tham khảo.`,
  });
}

/**
 * W13/U33c — the Size Guide page, rendered entirely from `PUBLIC_SIZE_GUIDE`.
 *
 * Measurements, units, tolerance, circumference semantics, and height/weight guidance are all read
 * directly from that single authority. Every chart it declares is rendered, each with its own size
 * scale, so a brand adding a third table gets a third table here and nothing else changes. No size
 * calculator, recommendation engine, fit vocabulary, or per-product mapping beyond B3 approved
 * facts is authored here.
 */
export default function SizeGuidePage() {
  const { unit, toleranceNote, circumferenceSemanticsNote, guidanceNote, charts } =
    PUBLIC_SIZE_GUIDE;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Thông tin sản phẩm</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Hướng dẫn chọn size
      </h1>

      <div className="mt-6 max-w-3xl space-y-3 text-base leading-7 text-black/75">
        <p>
          Tất cả thông số kích thước quần áo tại {BRAND.identity.name} được tính theo đơn vị{" "}
          <strong className="font-semibold text-black">{unit}</strong>.
        </p>
        <p>
          <strong>Lưu ý về số đo:</strong> {circumferenceSemanticsNote}
        </p>
        <p>
          <strong>Dung sai:</strong> {toleranceNote}
        </p>
        <p className="rounded-sm border border-black/10 bg-black/[0.02] p-4 text-sm leading-6 text-black/70">
          <strong>Lưu ý tham khảo:</strong> {guidanceNote}
        </p>
      </div>

      <div className="mt-16 grid max-w-5xl gap-16">
        {charts.map((chart) => (
          <section key={chart.id} aria-labelledby={`chart-${chart.id}-heading`}>
            <h2 id={`chart-${chart.id}-heading`} className="font-serif text-3xl tracking-[-0.03em]">
              {chart.title}
            </h2>
            <p className="mt-2 text-sm text-black/60">Đơn vị đo: {unit}. Dung sai: {describePublicSizeTolerance()}.</p>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <caption className="sr-only">{chart.title}</caption>
                <thead>
                  <tr className="border-b border-black/15 bg-black/[0.03]">
                    <th scope="col" className="py-3.5 pr-4 pl-3 font-semibold text-black">
                      Thông số
                    </th>
                    {chart.sizes.map((size) => (
                      <th key={size} scope="col" className="px-4 py-3.5 text-right font-semibold text-black">
                        {size}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {chart.rows.map((row) => (
                    <tr key={row.parameter} className="hover:bg-black/[0.01]">
                      <th scope="row" className="py-3.5 pr-4 pl-3 font-medium text-black/80">
                        {row.parameter}
                      </th>
                      {chart.sizes.map((size) => (
                        <td key={size} className="px-4 py-3.5 text-right tabular-nums text-black/70">
                          {row.values[size]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-16 max-w-2xl text-sm leading-6 text-black/65">
        Cần hỗ trợ tư vấn chọn size phù hợp?{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/contact"
        >
          Liên hệ {BRAND.identity.name}
        </Link>{" "}
        để được đội ngũ chăm sóc khách hàng hỗ trợ.
      </p>
    </div>
  );
}