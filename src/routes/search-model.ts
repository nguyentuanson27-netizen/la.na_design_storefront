/** The query to carry over, or `null` when the visit has none worth forwarding. */
export function searchRedirectTarget(
  params: Record<string, string | string[] | undefined>,
): string | null {
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = raw?.trim();
  if (!query) return null;
  return `/shop?${new URLSearchParams({ q: query }).toString()}`;
}
