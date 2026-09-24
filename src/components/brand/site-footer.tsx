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

type SocialNetwork = "instagram" | "tiktok" | "facebook";

/** Simple outline marks in the footer's ink, drawn inline so they inherit `currentColor`. */
function SocialIcon({ network }: Readonly<{ network: SocialNetwork }>) {
  const common = {
    "aria-hidden": true,
    focusable: false,
    viewBox: "0 0 24 24",
    width: 18,
    height: 18,
  } as const;
  if (network === "instagram") {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
        <circle cx="12" cy="12" r="3.9" />
        <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (network === "tiktok") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M16.3 3c.3 2.3 1.7 3.8 4 4v3.1a7 7 0 0 1-3.9-1.2v6.3c0 3.4-2.7 5.8-5.9 5.8a5.8 5.8 0 0 1-5.8-5.8c0-3.5 3-6.2 6.6-5.7v3.2c-1.6-.4-3.4.7-3.4 2.5 0 1.5 1.2 2.6 2.6 2.6 1.6 0 2.7-1.1 2.7-3V3h3.1Z" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="currentColor">
      <path d="M13.4 21v-7.6h2.6l.4-3h-3V8.5c0-.9.3-1.5 1.5-1.5h1.6V4.3c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.3H7.8v3h2.6V21h3Z" />
    </svg>
  );
}

/**
 * The brand's social profiles as round icon links, Instagram, TikTok, then Facebook. A profile
 * missing from Brand Config is left out rather than linked to a guess. Each icon is a 44px circle,
 * the footer's tap-target size, and its accessible name says both the network and the brand, since
 * the icon alone says nothing to a screen reader.
 */
function SocialLinks({ contact }: Readonly<{ contact: SiteFooterModel["contact"] }>) {
  const profiles: readonly (readonly [SocialNetwork, string, string | undefined])[] = [
    ["instagram", "Instagram", contact.instagramUrl],
    ["tiktok", "TikTok", contact.tiktokUrl],
    ["facebook", "Facebook", contact.fanpageUrl],
  ];

  return (
    <ul className="footer-social" aria-label="Mạng xã hội">
      {profiles.map(([network, label, href]) =>
        href ? (
          <li key={network}>
            <a
              className="footer-social__link"
              href={href}
              rel="noreferrer"
              target="_blank"
              aria-label={`${label} ${BRAND.identity.name}`}
            >
              <SocialIcon network={network} />
            </a>
          </li>
        ) : null,
      )}
    </ul>
  );
}

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

          {/* Each fact is one sentence: label, colon, value, in one inline flow. The label and the
              value used to be two grid rows, which made a two-word fact occupy two lines and left
              the rows an uneven height. The `{" "}` is a real space rather than a CSS margin so a
              screen reader reads `Hotline/Zalo: 0923159666` as one phrase. The colon is content,
              and matches how `policy.config.ts` already writes the same facts. */}
          <ul className="footer-contact-list">
            <li>
              <span className="footer-label">Hotline/Zalo:</span>{" "}
              <a href={`tel:${model.contact.telephoneInternational}`}>
                {model.contact.telephone}
              </a>
            </li>
            <li>
              <span className="footer-label">Email hỗ trợ:</span>{" "}
              <a href={`mailto:${model.contact.email}`}>{model.contact.email}</a>
            </li>
            <li>
              <span className="footer-label">Địa chỉ kinh doanh/đổi trả:</span>{" "}
              {model.address}
            </li>
            <li>
              <span className="footer-label">Giờ hỗ trợ:</span> {model.supportHours}
            </li>
          </ul>

          <SocialLinks contact={model.contact} />
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
