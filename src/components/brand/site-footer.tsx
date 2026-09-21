import Image from "next/image";
import Link from "next/link";

import { BRAND, NAVIGATION } from "@/brand";
import { FooterNavGroup } from "@/components/brand/footer-nav-group";
import type { SiteFooterModel } from "@/components/headless/site-chrome-model";

/**
 * F9a footer layout. Presentation consumes approved Brand Config and policy projections only:
 * shopping links stay in NAVIGATION, while support/policy/legal facts arrive through the chrome
 * model. There is deliberately no newsletter and no page-specific policy copy here. The legal
 * representative is rendered from that model since the owner released it for this block; it is not
 * typed into this file any more than the other legal facts are.
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

/**
 * The other half of §33's mobile rule: with scripting disabled the footer keeps every link.
 *
 * The disclosure is a React button, so without JavaScript it can never open. Collapsing the groups
 * anyway would leave a visitor with three buttons that do nothing and no way to reach the support
 * or policy pages, which is worse than the long footer the disclosures were introduced to fix. A
 * browser with scripting enabled never parses the contents of `<noscript>`, so this costs those
 * visitors nothing and changes nothing about the hydrated behaviour; a browser with scripting
 * disabled applies it and gets the same arrangement the desktop footer has.
 *
 * Each selector carries a `:root` prefix so it outranks the rule it reverses on specificity rather
 * than on where the browser happened to put this stylesheet, and the attribute value is unquoted so
 * the declaration survives HTML escaping if this ever stops being written as raw markup.
 */
const NO_SCRIPT_FOOTER_CSS = `
@media (max-width: 640px) {
  :root .footer-heading__static { display: inline; }
  :root .footer-disclosure { display: none; }
  :root .footer-group[data-open=false] .footer-panel { display: block; }
}
`;

export function SiteFooter({ model }: Readonly<{ model: SiteFooterModel }>) {
  return (
    <footer className="site-footer">
      <noscript>
        <style dangerouslySetInnerHTML={{ __html: NO_SCRIPT_FOOTER_CSS }} />
      </noscript>

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
        {/* Beside the entity it belongs to, not at the end of the block: the representative is part
            of who the company is, where the lines below are where to reach it. */}
        <p>Đại diện pháp luật: {model.legal.legalRepresentative}</p>
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
