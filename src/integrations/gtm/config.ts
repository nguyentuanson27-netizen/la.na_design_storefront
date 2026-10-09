export type GtmConfig = Readonly<{
  containerId: string;
}>;

const GTM_CONTAINER_ID_REGEX = /^GTM-[A-Z0-9]{4,10}$/;

export function readGtmConfig(
  env: Record<string, string | undefined> = process.env,
): GtmConfig | null {
  const raw = env.NEXT_PUBLIC_GTM_CONTAINER_ID ?? env.LA_GTM_CONTAINER_ID;
  if (!raw || !GTM_CONTAINER_ID_REGEX.test(raw)) return null;
  return Object.freeze({ containerId: raw });
}
