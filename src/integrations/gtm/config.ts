export type GtmConfig = Readonly<{
  containerId: string;
}>;

const GTM_CONTAINER_ID_REGEX = /^GTM-[A-Z0-9]{4,10}$/;

/**
 * Mirrors the id resolution in `next.config.mjs`, which derives the CSP: an empty value is unset, and
 * two different ids resolve to nothing (fail closed) so the loader never disagrees with the policy.
 */
export function readGtmConfig(
  env: Record<string, string | undefined> = process.env,
): GtmConfig | null {
  const publicId = (env.NEXT_PUBLIC_GTM_CONTAINER_ID ?? "").trim();
  const serverId = (env.LA_GTM_CONTAINER_ID ?? "").trim();
  if (publicId.length > 0 && serverId.length > 0 && publicId !== serverId) return null;
  const raw = publicId || serverId;
  if (!GTM_CONTAINER_ID_REGEX.test(raw)) return null;
  return Object.freeze({ containerId: raw });
}
