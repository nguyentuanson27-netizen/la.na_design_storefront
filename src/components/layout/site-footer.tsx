import Link from "next/link";

import { BRAND, NAVIGATION } from "@/brand";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import {
  buildPublicBrandFacts,
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_CONTACT_FACTS,
} from "@/content/public-brand-facts";

export function SiteFooter() {
  const brandFacts = buildPublicBrandFacts(readGuestShippingPolicy());

  return (
    <footer className="site-footer">
      <div>
        <p className="footer-kicker">{BRAND.identity.displayNameUpper}</p>
        <p className="footer-copy">{BRAND.identity.strapline}</p>

        <dl className="mt-8 grid max-w-2xl gap-5 text-sm leading-6">
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Thanh toán</dt>
            <dd className="mt-1 text-black/70">
              {brandFacts.paymentMethod} {brandFacts.checkoutAccount}
            </dd>
          </div>
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Vận chuyển</dt>
            <dd className="mt-1 text-black/70">
              {brandFacts.shipping.title}. {brandFacts.shipping.detail}
            </dd>
          </div>
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">{brandFacts.orderTracking.title}</dt>
            <dd className="mt-1 text-black/70">{brandFacts.orderTracking.detail}</dd>
          </div>
          {/*
            U32b/B2. The same owner-approved contact facts the site JSON-LD marks up on the
            Organization entity, rendered from the same authority so every marked-up fact is one a
            reader can actually see. The footer is site-wide, matching where that JSON-LD is
            injected. Only the approved §2 facts appear here — no support route, policy page or
            business claim the owner has not approved.
          */}
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Liên hệ</dt>
            <dd className="mt-1 text-black/70">
              {/*
                The visible text is the number exactly as the owner wrote it; the dial target uses
                the same number's international spelling, which is also what the Organization
                markup carries. One fact, two spellings, both from the authority.
              */}
              <a
                className="underline underline-offset-4"
                href={`tel:${PUBLIC_CONTACT_FACTS.telephoneInternational}`}
              >
                {PUBLIC_CONTACT_FACTS.telephone}
              </a>{" "}
              (hotline &amp; Zalo) ·{" "}
              <a className="underline underline-offset-4" href={`mailto:${PUBLIC_CONTACT_FACTS.email}`}>
                {PUBLIC_CONTACT_FACTS.email}
              </a>
            </dd>
            <dd className="mt-1 text-black/70">{describePublicAddress()}</dd>
            <dd className="mt-1 text-black/70">Hỗ trợ {describePublicSupportHours()}</dd>
            <dd className="mt-1 text-black/70">
              <a
                className="underline underline-offset-4"
                href={PUBLIC_CONTACT_FACTS.fanpageUrl}
                rel="noreferrer"
                target="_blank"
              >
                Fanpage {BRAND.identity.name}
              </a>
            </dd>
          </div>
        </dl>
      </div>

      <nav className="footer-links" aria-label="Liên kết cuối trang">
        {NAVIGATION.footer.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>

      <p className="footer-meta">© 2026 {BRAND.identity.name}</p>
    </footer>
  );
}
