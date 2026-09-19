import Link from "next/link";

import { BRAND } from "@/brand";
import { createStorefrontRoute } from "@/routes/factory";
import { loadSizeGuideRoute, type SizeGuideRouteProps } from "@/routes/size-guide";
import type { SizeGuideViewModel } from "@/routes/evergreen-model";
import { buildSizeGuideMetadata } from "@/routes/metadata/size-guide";

/**
 * W13/U33c — the Size Guide page, rendered entirely from `PUBLIC_SIZE_GUIDE`.
 *
 * Measurements, units, circumference semantics, and height/weight guidance all arrive through the
 * view model, which reads that single authority. Every chart it declares is rendered, each with its
 * own size scale, so a brand adding a table gets a table here and nothing else changes. No size
 * calculator, recommendation engine, fit vocabulary, or per-product mapping beyond the approved
 * facts is authored here.
 *
 * Tolerance is rendered only when the brand publishes one. La.na Design has no fixed manufacturing
 * tolerance, so both the intro statement and the per-chart caption clause are omitted rather than
 * printed empty or filled with a `±0 cm` nobody approved.
 *
 * **Units are stated per row, never once for the page.** §11 splits them — body measurements and
 * height in centimetres, weight in kilograms — so every chart here mixes two units, and a heading
 * that announced a single one would be false for every table under it. Each row parameter carries
 * its own `(cm)` or `(kg)`, which is the only place a unit is claimed.
 */

function render(data: SizeGuideViewModel) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Thông tin sản phẩm</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Hướng dẫn chọn size
      </h1>

      <div className="mt-6 max-w-3xl space-y-3 text-base leading-7 text-black/75">
        <p>
          <strong>Lưu ý về số đo:</strong> {data.circumferenceSemanticsNote}
        </p>
        {data.tolerance === null ? null : (
          <p>
            <strong>Dung sai:</strong> {data.tolerance.note}
          </p>
        )}
        <p className="rounded-sm border border-black/10 bg-black/[0.02] p-4 text-sm leading-6 text-black/70">
          <strong>Lưu ý tham khảo:</strong> {data.guidanceNote}
        </p>
      </div>

      <div className="mt-16 grid max-w-5xl gap-16">
        {data.charts.map((chart) => (
          <section key={chart.id} aria-labelledby={`chart-${chart.id}-heading`} className="min-w-0">
            <h2 id={`chart-${chart.id}-heading`} className="font-serif text-3xl tracking-[-0.03em]">
              {chart.title}
            </h2>
            {data.tolerance === null ? null : (
              <p className="mt-2 text-sm text-black/60">Dung sai: {data.tolerance.text}.</p>
            )}

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

const route = createStorefrontRoute<SizeGuideRouteProps, SizeGuideViewModel>({
  load: loadSizeGuideRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildSizeGuideMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
