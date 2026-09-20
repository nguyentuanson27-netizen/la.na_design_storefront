import Image from "next/image";
import Link from "next/link";

import { BRAND, NAVIGATION } from "@/brand";
import { FooterNavGroup } from "@/components/brand/footer-nav-group";
import type { SiteFooterModel } from "@/components/headless/site-chrome-model";

/**
 * F9a footer layout. Presentation consumes approved Brand Config and policy projections only:
 * shopping links stay in NAVIGATION, while support/policy/legal facts arrive through the chrome
 * model. There is deliberately no newsletter, representative field or page-specific policy copy
 * here.
 *
 * The three link columns collapse into disclosures on the single-column mobile footer, which the
 * owner approved in place of the original always-expanded mobile rule -- twenty-odd links between
 * the page and the legal block is a scroll, not a footer. `FooterNavGroup` owns that behaviour and
 * keeps every link visible wherever the footer is still a column.
 *
 * The footer master logo is the owner-approved production PNG recorded in the owner-facts
 * authority. It is committed byte-for-byte under public/brand; no favicon/social-card derivation or
 * restyling is performed here.
 */
export function SiteFooter({ model }: Readonly<{ model: SiteFooterModel }>) {
  return (
    <footer className="site-footer">
      <div className="footer-groups">
        <section className="footer-group footer-group--brand" data-footer-group>
          <h2 className="footer-brand-heading">
            <Link className="footer-brand-mark" href="/">
              <Image
                className="footer-brand-logo"
                src="/brand/la-na-design-master-logo.png"
                alt={BRAND.identity.name}
                width={4185}
                height={2148}
                sizes="176px"
                loading="lazy"
              />
            </Link>
          </h2>
          <p className="footer-copy">{BRAND.identity.strapline}</p>

          <ul className="footer-contact-list">
            <li>
              <span className="footer-label">Hotline/Zalo</span>
              <a href={`tel:${model.contact.telephoneInternational}`}>
                {model.contact.telephone}
              </a>
            </li>
            <li>
              <span className="footer-label">Email hỗ trợ</span>
              <a href={`mailto:${model.contact.email}`}>{model.contact.email}</a>
            </li>
            <li>
              <span className="footer-label">Địa chỉ kinh doanh/đổi trả</span>
              <span>{model.address}</span>
            </li>
            <li>
              <span className="footer-label">Giờ hỗ trợ</span>
              <span>{model.supportHours}</span>
            </li>
            <li>
              <a href={model.contact.fanpageUrl} rel="noreferrer" target="_blank">
                Facebook {BRAND.identity.name}
              </a>
            </li>
          </ul>
        </section>

        <FooterNavGroup
          heading="Mua sắm"
          navigationLabel="Mua sắm"
          panelId="footer-shopping-links"
          links={NAVIGATION.footer}
        />

        <FooterNavGroup
          heading="Hỗ trợ khách hàng"
          navigationLabel="Hỗ trợ khách hàng"
          panelId="footer-support-links"
          links={model.supportLinks}
        />

        <FooterNavGroup
          heading="Thông tin & chính sách"
          navigationLabel="Thông tin và chính sách"
          panelId="footer-policy-links"
          links={model.policyLinks}
        />
      </div>

      <div className="footer-legal" data-footer-legal>
        <p className="footer-label">Thông tin pháp lý</p>
        <p className="footer-legal-name">{model.legal.legalEntityName}</p>
        <p>Địa chỉ đăng ký: {model.legal.registeredAddress}</p>
        <p>
          MST: {model.legal.taxCode} - ngày cấp: {model.legal.taxIdIssueDate}
        </p>
        <p>Email: {model.legal.legalEmail}</p>
      </div>

      <p className="footer-meta">© 2026 {BRAND.identity.name}</p>
    </footer>
  );
}
