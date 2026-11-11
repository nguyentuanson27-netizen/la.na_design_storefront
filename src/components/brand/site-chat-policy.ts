/**
 * Which chat entry point a page shows. Pure, so the admin boundary is unit-tested without a browser
 * (tests/domain/site-chat-policy.test.ts).
 */

export type SiteChatKind = "zalo" | "none";

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * - Admin shows no chat at all.
 * - Everywhere else the Zalo link button, provided the shop has a Zalo link to point at.
 */
export function siteChatFor({
  pathname,
  zaloHref,
}: Readonly<{ pathname: string; zaloHref: string | null }>): SiteChatKind {
  if (isAdminPath(pathname) || zaloHref === null) return "none";
  return "zalo";
}
