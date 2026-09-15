type StorefrontOriginEnvironment = Readonly<Record<string, string | undefined>>;

export const OFFICIAL_PRODUCTION_STOREFRONT_HOST = "www.lanadesign.vn";
export const LEGACY_TEMPORARY_STOREFRONT_HOST = "la.lanadesign.vn";

const MAX_APP_DOMAIN_LENGTH = 255;
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function invalidAppDomain(): never {
  throw new Error(
    "APP_DOMAIN must be a valid server-owned hostname without scheme, path, credentials, or non-local port",
  );
}

function parsePort(value: string): string {
  if (!/^\d{1,5}$/.test(value)) invalidAppDomain();
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) invalidAppDomain();
  return String(port);
}

export function readStorefrontOrigin(
  env: StorefrontOriginEnvironment = process.env,
): string {
  const raw = env.APP_DOMAIN;
  if (!raw || raw.trim().length === 0) {
    throw new Error("APP_DOMAIN must be configured on the server");
  }
  if (raw !== raw.trim() || raw.length > MAX_APP_DOMAIN_LENGTH) invalidAppDomain();
  if (/[\s/@?#]/.test(raw) || raw.includes("://")) invalidAppDomain();

  const parts = raw.split(":");
  if (parts.length > 2) invalidAppDomain();

  const hostname = parts[0]?.toLowerCase();
  if (!hostname || !HOSTNAME_PATTERN.test(hostname)) invalidAppDomain();

  const isLocal = LOCAL_HOSTNAMES.has(hostname);
  if (IPV4_PATTERN.test(hostname) && !isLocal) invalidAppDomain();

  const rawPort = parts[1];
  if (rawPort !== undefined && !isLocal) invalidAppDomain();
  const port = rawPort === undefined ? "" : `:${parsePort(rawPort)}`;

  return `${isLocal ? "http" : "https"}://${hostname}${port}`;
}
