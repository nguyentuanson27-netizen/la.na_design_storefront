/** Public storefront paths only; queries may contain order codes, search text or auth parameters. */
export function readMetaPagePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 250) return null;
  if (!/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(value)) return null;
  if (/^\/(?:api|admin|account|login)(?:\/|$)/.test(value)) return null;
  return value;
}
