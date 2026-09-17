import Link from "next/link";

import { BRAND } from "@/brand";
import { createStorefrontRoute } from "@/routes/factory";
import { loadContactRoute, type ContactRouteProps } from "@/routes/contact";
import type { ContactViewModel } from "@/routes/evergreen-model";
import { buildContactMetadata } from "@/routes/metadata/contact";

import { ContactForm } from "./contact-form";

/**
 * W13/U33a — the evergreen Contact page.
 *
 * Every fact here arrives through the view model, which reads `PUBLIC_CONTACT_FACTS` — the same
 * authority the site footer renders and the `Organization` structured data marks up. Nothing is
 * transcribed a second time: a phone number that appears in three places and is owned by one
 * constant cannot go stale in two of them.
 *
 * The page claims no support channel the owner did not approve. There is no live chat, and the
 * complaint response target is the approved one from the policy authority rather than a promise
 * phrased here.
 *
 * The address shown is the **business and return** address, labelled as such. The registered office
 * is a different place and belongs to About; a page offering a bare "Địa chỉ" is how a customer
 * posts a return to a registered office that does not receive post.
 *
 * Outbound delivery for a contact form is G3/F9b work and is deliberately absent: no provider, no
 * form, and nothing that could tell a visitor a message was sent when nothing sent it.
 */

const CONTACT_LINK =
  "underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4";

function render(data: ContactViewModel) {
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

      <ContactForm />

      <dl className="mt-12 grid max-w-2xl gap-8 text-base leading-7">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Hotline &amp; Zalo</dt>
          <dd className="mt-2">
            <a className={CONTACT_LINK} href={`tel:${data.telephoneInternational}`}>
              {data.telephone}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Email</dt>
          <dd className="mt-2">
            <a className={CONTACT_LINK} href={`mailto:${data.email}`}>
              {data.email}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
            Địa chỉ kinh doanh &amp; nhận hàng đổi trả
          </dt>
          <dd className="mt-2 text-black/70">{data.businessAddress}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Giờ hỗ trợ</dt>
          <dd className="mt-2 text-black/70">{data.supportHours}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">
            Tiếp nhận và giải quyết khiếu nại
          </dt>
          <dd className="mt-2 text-black/70">{data.complaintResponse}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.13em]">Fanpage</dt>
          <dd className="mt-2">
            <a className={CONTACT_LINK} href={data.fanpageUrl} rel="noreferrer" target="_blank">
              {data.fanpageLabel}
            </a>
          </dd>
        </div>
      </dl>

      <p className="mt-12 max-w-2xl text-sm leading-6 text-black/65">
        Cần tra cứu một đơn hàng đã đặt?{" "}
        <Link className={CONTACT_LINK} href="/track-order">
          Tra cứu đơn hàng
        </Link>{" "}
        bằng mã đơn và số điện thoại đã dùng khi đặt.
      </p>
    </div>
  );
}

const route = createStorefrontRoute<ContactRouteProps, ContactViewModel>({
  load: loadContactRoute,
  render,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildContactMetadata(props),
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
