import { splitLocalePath } from "../../i18n/locale.ts";

/**
 * Public storefront paths only; queries may contain order codes, search text or auth parameters.
 * A language prefix (`/en/shop`) is read through: the event is about the page `/shop`, and the deny
 * list below must apply to `/en/account` exactly as it does to `/account`.
 */
export function readMetaPagePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 250) return null;
  const path = splitLocalePath(value).pathname;
  if (!/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(path)) return null;
  if (/^\/(?:api|admin|account|login)(?:\/|$)/.test(path)) return null;
  return path;
}
