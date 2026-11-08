import { BRAND_MESSAGES_EN } from "../../brand/messages.en.ts";
import { BRAND_POLICY_MESSAGES_EN } from "../../brand/messages.policy.en.ts";
import { CHROME_EN } from "./chrome.ts";
import { CONTENT_EN } from "./content.ts";
import { FLOWS_EN } from "./flows.ts";
import { STOREFRONT_EN } from "./storefront.ts";

/**
 * The English catalog: Vietnamese source text -> English. One file per area of the site, merged
 * here. A source with no entry renders in Vietnamese, so the catalog can grow page by page;
 * `pnpm i18n:audit` lists what is still missing.
 *
 * Two sets. `EN_CLIENT_MESSAGES` is what client components can look up and is serialized into every
 * English page, so it holds the chrome and the shopping surfaces only. `EN_MESSAGES` adds the long
 * prose that only server components render (policies, About, page titles) and stays on the server.
 * A client component that needs a string must find it in the client set.
 */
export const EN_CLIENT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...BRAND_MESSAGES_EN,
  ...CHROME_EN,
  ...STOREFRONT_EN,
  ...FLOWS_EN,
});

export const EN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...EN_CLIENT_MESSAGES,
  ...CONTENT_EN,
  ...BRAND_POLICY_MESSAGES_EN,
});
