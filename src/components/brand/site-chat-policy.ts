/**
 * Which chat entry point a page shows. Pure, so the host and admin boundaries are unit-tested
 * without a browser (tests/domain/site-chat-policy.test.ts).
 */

export type SiteChatKind = "pancake" | "messenger" | "none";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * - Admin shows no chat at all.
 * - The Pancake widget loads only when the page is actually served on the host registered with
 *   Pancake -- the browser's own `location.hostname`, matched exactly, not the server's configured
 *   domain, so a production container reached through any other host still falls back.
 * - Everywhere else the Messenger link button stands in.
 * - `hostname` is `null` while rendering on the server and hydrating, when no chat is shown yet.
 */
export function siteChatFor({
  hostname,
  pathname,
  pancakePageId,
  pancakeHost,
}: Readonly<{
  hostname: string | null;
  pathname: string;
  pancakePageId: string | undefined;
  pancakeHost: string;
}>): SiteChatKind {
  if (hostname === null || isAdminPath(pathname)) return "none";
  if (pancakePageId && hostname === pancakeHost) return "pancake";
  return "messenger";
}
