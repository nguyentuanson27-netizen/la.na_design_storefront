import type { Metadata } from "next";
import Link from "next/link";

import {
  describePublicExchangeFee,
  describePublicRefundWindow,
  describePublicReturnWindow,
  PUBLIC_RETURNS_POLICY,
} from "@/content/public-brand-facts";
import { BRAND } from "@/brand";
import { PUBLIC_RETURN_LOGISTICS_FACTS } from "@/content/public-fulfillment-facts";
import { readSearchExposure } from "@/seo/search-exposure";
import { buildStaticPageMetadata } from "@/seo/static-page-metadata";

type ReturnsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: ReturnsPageProps): Promise<Metadata> {
  const exposure = readSearchExposure();
  return buildStaticPageMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    pathname: "/returns",
    searchParams: await searchParams,
    title: "Chính sách đổi trả và hoàn tiền",
    description: `Đổi trả trong ${describePublicReturnWindow()}, điều kiện sản phẩm, phí đổi và thời gian hoàn tiền của ${BRAND.identity.name}.`,
  });
}

/**
 * W13/U33b + U41/M5 — public returns policy from owner-approved authorities only.
 *
 * `PUBLIC_RETURNS_POLICY` keeps the existing window, eligibility, fee and refund facts;
 * `PUBLIC_RETURN_LOGISTICS_FACTS` carries the later owner-approved return methods, restocking
 * decision and the exchange-only rule for correct/non-defective customer-change cases. Page prose
 * only labels sections: every normative return statement below comes from one of those reviewed
 * content authorities.
 */
export default function ReturnsPage() {
  const {
    productConditions,
    supportedCases,
    customerInitiatedShippingNote,
    shopFaultShippingNote,
    nonReturnableCategories,
    nonReturnableCategoriesNote,
    refundChannelNote,
  } = PUBLIC_RETURNS_POLICY;
  const { returnMethods, restockingFeeNote, nonDefectiveRefundNote } =
    PUBLIC_RETURN_LOGISTICS_FACTS;

  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Chính sách</p>
      <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
        Đổi trả &amp; hoàn tiền
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8">
        {BRAND.identity.name} hỗ trợ đổi/trả trong vòng <strong>{describePublicReturnWindow()}</strong>.
      </p>

      <div className="mt-16 grid max-w-4xl gap-14">
        <section aria-labelledby="conditions-heading">
          <h2 id="conditions-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Điều kiện sản phẩm
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-black/70">
            Sản phẩm đổi/trả phải đáp ứng đủ các điều kiện sau:
          </p>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            {productConditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="cases-heading">
          <h2 id="cases-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Trường hợp được hỗ trợ
          </h2>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            {supportedCases.map((supportedCase) => (
              <li key={supportedCase}>{supportedCase}</li>
            ))}
          </ul>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {nonDefectiveRefundNote}
          </p>
          {nonReturnableCategories.length === 0 ? (
            <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
              {nonReturnableCategoriesNote}
            </p>
          ) : (
            <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
              {nonReturnableCategories.map((category) => (
                <li key={category}>{category}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="return-method-heading">
          <h2 id="return-method-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Cách trả hàng
          </h2>
          <ul className="mt-6 max-w-2xl list-disc space-y-2 pl-6 text-base leading-7">
            <li>{returnMethods.inStore}</li>
            <li>{returnMethods.byMail}</li>
          </ul>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            {returnMethods.byMailResponsibility}
          </p>
        </section>

        <section aria-labelledby="fees-heading">
          <h2 id="fees-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Chi phí đổi trả
          </h2>
          <dl className="mt-6 grid max-w-2xl gap-6 text-base leading-7">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                Khách hàng chủ động đổi mẫu / size / màu
              </dt>
              <dd className="mt-2 text-black/70">
                Phí đổi {describePublicExchangeFee()}. {customerInitiatedShippingNote}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
                Lỗi thuộc shop hoặc nhà sản xuất
              </dt>
              <dd className="mt-2 text-black/70">{shopFaultShippingNote}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Phí restocking</dt>
              <dd className="mt-2 text-black/70">{restockingFeeNote}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="refund-heading">
          <h2 id="refund-heading" className="font-serif text-3xl tracking-[-0.03em]">
            Hoàn tiền
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-black/70">
            Thời gian hoàn tiền dự kiến {describePublicRefundWindow()}. {refundChannelNote}
          </p>
        </section>
      </div>

      <p className="mt-16 max-w-2xl text-sm leading-6 text-black/65">
        Cần hỗ trợ đổi trả?{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/contact"
        >
          Liên hệ {BRAND.identity.name}
        </Link>{" "}
        để được hướng dẫn gửi lại sản phẩm.
      </p>
    </div>
  );
}
