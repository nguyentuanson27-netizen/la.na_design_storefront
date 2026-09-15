import {
  describePublicAddress,
  describePublicSupportHours,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_LEGAL_FACTS,
} from "../content/public-brand-facts.ts";

/**
 * What the evergreen pages show, read from the fact authority rather than written into markup.
 *
 * These pages have no request-time data: everything on them is an owner-approved fact. The model
 * exists so the markup can be redrawn per brand without carrying the facts with it, and so the one
 * place a fact can change stays the place the owner's decision is transcribed. Nothing here
 * authors copy — every field is a constant or one of the `describe*` helpers.
 */

export type AboutViewModel = Readonly<{
  positioning: string;
  legalEntityName: string;
  taxCode: string;
  address: string;
}>;

export function buildAboutViewModel(): AboutViewModel {
  return Object.freeze({
    positioning: PUBLIC_BRAND_POSITIONING,
    legalEntityName: PUBLIC_LEGAL_FACTS.legalEntityName,
    taxCode: PUBLIC_LEGAL_FACTS.taxCode,
    address: describePublicAddress(),
  });
}

export type ContactViewModel = Readonly<{
  telephone: string;
  /** E.164, for the `tel:` href. Never shown. */
  telephoneInternational: string;
  email: string;
  address: string;
  supportHours: string;
  fanpageUrl: string;
  /** The fanpage as a reader sees it. */
  fanpageLabel: string;
}>;

/**
 * The fanpage link's visible text, derived from the URL the config holds.
 *
 * `www.` is dropped because it is not how anyone writes a page's name. Deriving rather than
 * transcribing matters here: the label was previously written into the markup, so a brand that
 * changed `fanpageUrl` would have shipped a link whose text named someone else's page.
 */
function describeFanpage(fanpageUrl: string): string {
  const url = new URL(fanpageUrl);
  return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
}

export function buildContactViewModel(): ContactViewModel {
  return Object.freeze({
    telephone: PUBLIC_CONTACT_FACTS.telephone,
    telephoneInternational: PUBLIC_CONTACT_FACTS.telephoneInternational,
    email: PUBLIC_CONTACT_FACTS.email,
    address: describePublicAddress(),
    supportHours: describePublicSupportHours(),
    fanpageUrl: PUBLIC_CONTACT_FACTS.fanpageUrl,
    fanpageLabel: describeFanpage(PUBLIC_CONTACT_FACTS.fanpageUrl),
  });
}
