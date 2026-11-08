import { BRAND_MESSAGES_EN } from "../../brand/messages.en.ts";
import { CHROME_EN } from "./chrome.ts";

/**
 * The English catalog: Vietnamese source text -> English. One file per area of the site, merged
 * here. A source with no entry renders in Vietnamese, so the catalog can grow page by page;
 * `pnpm i18n:audit` lists what is still missing.
 */
export const EN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...BRAND_MESSAGES_EN,
  ...CHROME_EN,
});
