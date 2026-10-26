/**
 * The runtime switch for the browser pixel's manual advanced matching (hashed `ph`/`fn`/`ln` from
 * checkout, ADR 0018). Anything but exact `true` is off, and it ships off: the feature sends
 * customer identifiers to Meta from real checkouts, so it is turned on deliberately, after the real
 * pixel has been seen to apply them (Test Events / Pixel Helper), and off again without a deploy.
 * Like the first-party cookie switch it is read per request by the server-rendered pixel snippet.
 */
export function readMetaAdvancedMatchingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.LA_META_ADVANCED_MATCHING_ENABLED === "true";
}
