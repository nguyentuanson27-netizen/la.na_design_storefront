/**
 * Which country an IP address is in, from a table shipped inside the `ip3country` package
 * (IP2Location LITE DB1, country level, IPv4). No network call, no file read at request time and no
 * licence key: the table is a JS module the bundler includes, expanded once per process on first use.
 *
 * This site's edge (NPM -> Caddy) adds no country header, so the lookup has to happen here. The
 * answer is a hint for choosing a language, never a security decision.
 *
 * Attribution required by the data licence (CC BY 4.0): "This site or product includes IP2Location
 * LITE data available from https://lite.ip2location.com". It is recorded in ADR 0025.
 */

import { isIPv4, isIPv6 } from "node:net";
import ip3country from "ip3country";

const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

let initialised = false;

/** The IPv4 form of an address, or null for IPv6 (the table has no IPv6 ranges) and for junk. */
export function readIpv4(ip: string): string | null {
  const text = ip.trim();
  if (isIPv4(text)) return text;
  if (isIPv6(text)) {
    const mapped = IPV4_MAPPED_IPV6.exec(text);
    if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  }
  return null;
}

/**
 * The ISO 3166-1 alpha-2 code ("VN", "US") of an IP address, upper-case, or null when the address is
 * IPv6, private, malformed or not in the table. Null means "unknown", and callers treat unknown as
 * "do not change anything for this visitor".
 */
export function lookupCountry(ip: string): string | null {
  const ipv4 = readIpv4(ip);
  if (ipv4 === null) return null;
  try {
    if (!initialised) {
      ip3country.init();
      initialised = true;
    }
    const country = ip3country.lookupStr(ipv4);
    return typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
  } catch {
    return null;
  }
}
