/**
 * Every request a storefront page can make for an optimized product photograph: the stock
 * `next/image` optimizer, and the same-origin Pancake delivery endpoint the PDP gallery uses.
 *
 * These specs use fixture Pancake URLs that do not exist on the live CDN, so the browser stubs
 * both; the endpoint itself is exercised against the production server in p18-final-qa.spec.ts.
 */
export const OPTIMIZED_IMAGE_ROUTE = /\/(?:_next\/image|api\/product-image)\?/;

/** The source photograph an optimized-image request asks for, whichever endpoint carries it. */
export function optimizedImageSource(requestUrl: string): string {
  const params = new URL(requestUrl).searchParams;
  return params.get("url") ?? params.get("src") ?? "";
}
