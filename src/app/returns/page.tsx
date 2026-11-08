import Link from "@/components/brand/localized-link";

import { BRAND } from "@/brand";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute, type RequestI18n } from "@/routes/factory";
import { loadReturnsRoute, type ReturnsRouteProps } from "@/routes/returns";
import type { ReturnsViewModel } from "@/routes/evergreen-model";
import { buildReturnsMetadata } from "@/routes/metadata/returns";

/**
 * W13/U33b + U41/M5 — public returns policy from owner-approved authorities only.
 *
 * `PUBLIC_RETURNS_POLICY` keeps the existing window, eligibility, fee and refund facts;
 * `FULFILLMENT.returnLogistics` carries the later owner-approved return methods, restocking
 * decision and the exchange-only rule for correct/non-defective customer-change cases. Page prose
 * only labels sections: every normative return statement below arrives through the view model,
 * which reads one of those reviewed content authorities.
 */

function render(data: ReturnsViewModel, { t, rich }: RequestI18n) {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Đổi trả & hoàn tiền" }]} />
      <PageHeader
        eyebrow={t("Chính sách")}
        title={t("Đổi trả & hoàn tiền")}
        lead={rich("{name} hỗ trợ đổi/trả trong vòng <strong>{window}</strong>.", { name: BRAND.identity.name, window: t(data.returnWindow) })}
      />

      <div className="mt-10 grid max-w-4xl gap-14">
        <section aria-labelledby="conditions-heading">
          <h2 id="conditions-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Điều kiện sản phẩm")}
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            {t("Sản phẩm đổi/trả phải đáp ứng đủ các điều kiện sau:")}
          </p>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            {data.productConditions.map((condition) => (
              <li key={condition}>{t(condition)}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="cases-heading">
          <h2 id="cases-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Trường hợp được hỗ trợ")}
          </h2>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            {data.supportedCases.map((supportedCase) => (
              <li key={supportedCase}>{t(supportedCase)}</li>
            ))}
          </ul>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {t(data.nonDefectiveRefundNote)}
          </p>
          {data.nonReturnableCategories.length === 0 ? (
            <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
              {t(data.nonReturnableCategoriesNote)}
            </p>
          ) : (
            <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
              {data.nonReturnableCategories.map((category) => (
                <li key={category}>{t(category)}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="return-method-heading">
          <h2 id="return-method-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Cách trả hàng")}
          </h2>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            <li>{t(data.returnInStore)}</li>
            <li>{t(data.returnByMail)}</li>
          </ul>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {t(data.returnByMailResponsibility)}
          </p>
        </section>

        <section aria-labelledby="fees-heading">
          <h2 id="fees-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Chi phí đổi trả")}
          </h2>
          <dl className="mt-6 grid max-w-2xl gap-6 text-base leading-7">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {t("Khách hàng chủ động đổi mẫu / size / màu")}
              </dt>
              <dd className="mt-2 text-black/70">
                {t("Phí đổi {fee}.", { fee: t(data.exchangeFee) })} {t(data.customerInitiatedShippingNote)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                {t("Lỗi thuộc shop hoặc nhà sản xuất")}
              </dt>
              <dd className="mt-2 text-black/70">{t(data.shopFaultShippingNote)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">{t("Phí restocking")}</dt>
              <dd className="mt-2 text-black/70">{t(data.restockingFeeNote)}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="refund-heading">
          <h2 id="refund-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            {t("Hoàn tiền")}
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {t("Thời gian hoàn tiền dự kiến {window}.", { window: t(data.refundWindow) })} {t(data.refundChannelNote)}
          </p>
        </section>
      </div>

      <p className="mt-16 max-w-2xl text-sm leading-6 text-black/65">
        {t("Cần hỗ trợ đổi trả?")}{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/contact"
        >
          {t("Liên hệ {name}", { name: BRAND.identity.name })}
        </Link>{" "}
        {t("để được hướng dẫn gửi lại sản phẩm.")}
      </p>
    </PageShell>
  );
}

const route = createStorefrontRoute<ReturnsRouteProps, ReturnsViewModel>({
  load: loadReturnsRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildReturnsMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
