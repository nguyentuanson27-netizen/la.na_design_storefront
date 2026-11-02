/**
 * One unambiguous cache key for a tuple of listing parameters.
 *
 * Shopper-controlled fields (`size`, `color`, `q`) may contain any character, so joining them with a
 * separator lets two different filters collide on one key and one shopper's page be served for
 * another's. A JSON array keeps every field's boundary, whatever the field holds.
 */
export function storefrontCacheKey(parts: readonly (string | number | boolean | null | undefined)[]): string {
  return JSON.stringify(parts.map((part) => part ?? null));
}
