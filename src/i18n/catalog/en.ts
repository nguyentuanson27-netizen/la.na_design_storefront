import { BRAND_MESSAGES_EN } from "../../brand/messages.en.ts";
import { BRAND_POLICY_MESSAGES_EN } from "../../brand/messages.policy.en.ts";
import { CHROME_EN } from "./chrome.ts";
import { CONTENT_EN } from "./content.ts";
import { FLOWS_EN } from "./flows.ts";
import { PROSE_EN } from "./prose.ts";
import { STOREFRONT_EN } from "./storefront.ts";
import { TRYON_EN } from "./tryon.ts";

/**
 * The English catalog: Vietnamese source text -> English. One file per area of the site, merged
 * here. A source with no entry renders in Vietnamese, so the catalog can grow page by page;
 * `pnpm i18n:audit` lists what is still missing.
 *
 * Two sets. `EN_CLIENT_MESSAGES` is what client components can look up and is serialized into every
 * English page, so it holds short interface text: the chrome, the shopping surfaces, page labels.
 * `EN_MESSAGES` adds the long prose that only server components render (legal policies, About,
 * page descriptions) and stays on the server. Short text goes in the client set by default, because
 * a shared component may translate a string a server page handed it; only long prose is kept back.
 */
export const EN_CLIENT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...BRAND_MESSAGES_EN,
  ...CHROME_EN,
  ...CONTENT_EN,
  ...STOREFRONT_EN,
  ...FLOWS_EN,
  ...TRYON_EN,
});

export const EN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...EN_CLIENT_MESSAGES,
  ...PROSE_EN,
  ...BRAND_POLICY_MESSAGES_EN,
});
