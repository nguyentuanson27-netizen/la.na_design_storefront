import Link from "next/link";

import { BRAND } from "@/brand";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadAboutRoute, type AboutRouteProps } from "@/routes/about";
import type { AboutViewModel } from "@/routes/evergreen-model";
import { buildAboutMetadata } from "@/routes/metadata/about";

/**
 * W13/U33a — the minimal About page B6 approves, and deliberately no more than that.
 *
 * Approved for publication: the brand positioning, the legal entity, its registered address, the
 * confirmed MST with its issue date, and the corporate email. The founding year, the founder and any
 * brand story or values are withheld, so this page has no origin story, no mission statement and no
 * team section — not because they would not read well, but because no approved source states them
 * and a coding agent may not author a brand's history. **The legal representative is withheld too**
 * and has no field to render.
 *
 * A7a: the registered address and the business address are shown under different headings because
 * they are different places. A customer sending a return needs the second one, and a page that
 * offered only "Địa chỉ" would leave them guessing which they were looking at.
 *
 * Every fact it shows arrives through the view model, which reads the fact authority. Nothing is
 * transcribed here, so the one place any of it can change stays the place the owner's decision is.
 */

function render(data: AboutViewModel) {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Về thương hiệu" }]} />
      <PageHeader
        eyebrow="Thương hiệu"
        title={`Về ${BRAND.identity.name}`}
        lead={data.positioning}
      />

      <section aria-labelledby="legal-heading" className="mt-10">
        <h2 id="legal-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
          Thông tin pháp lý
        </h2>
        <dl className="mt-8 grid max-w-2xl gap-6 text-base leading-7">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Đơn vị chủ quản</dt>
            <dd className="mt-2 text-black/70">{data.legalEntityName}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Mã số thuế</dt>
            <dd className="mt-2 text-black/70">
              {data.taxCode} — ngày cấp: {data.taxIdIssueDate}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
              Địa chỉ đăng ký kinh doanh
            </dt>
            <dd className="mt-2 text-black/70">{data.registeredAddress}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Email công ty</dt>
            <dd className="mt-2 text-black/70">{data.legalEmail}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
              Địa chỉ kinh doanh &amp; nhận hàng đổi trả
            </dt>
            <dd className="mt-2 text-black/70">{data.businessAddress}</dd>
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
    </PageShell>
  );
}

const route = createStorefrontRoute<AboutRouteProps, AboutViewModel>({
  load: loadAboutRoute,
  render,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildAboutMetadata(props),
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
