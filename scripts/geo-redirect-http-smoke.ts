import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * ADR 0025 against the real Next proxy (a dev server, with the trusted client-IP header configured
 * the way production is): what a foreign first visit to `/` actually receives, and every case that
 * must NOT be redirected. The pure rules are covered in tests/domain/i18n-geo-redirect.test.ts; this
 * is the part they cannot see -- the proxy wiring, the server-owned Location, the cookies, the
 * cache header, and the `/en` pass that follows.
 *
 * Nothing here needs the database for the redirect itself: it is answered before anything renders.
 * Where a response was rendered (`/en`, `/en/shop`) the assertions read the document's language.
 */

const HOST = "127.0.0.1";
const PORT = 3223;
const TRUSTED_IP_HEADER = "x-la-client-ip";
const STOREFRONT_DOMAIN = "storefront.example.test";
const STOREFRONT_ORIGIN = `https://${STOREFRONT_DOMAIN}`;
const DIST_DIRECTORY = ".next-test/geo-redirect";
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const US_IP = "8.8.8.8";
const VN_IP = "125.235.0.1";

let server: ChildProcess | undefined;
let serverOutput = "";

type Reply = Readonly<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function request(path: string, headers: Record<string, string>, method = "GET"): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const outgoing = http.request(
      { host: HOST, port: PORT, path, method, headers, timeout: 60_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveReply({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
      },
    );
    outgoing.on("error", reject);
    outgoing.on("timeout", () => outgoing.destroy(new Error(`timeout: ${path}`)));
    outgoing.end();
  });
}

/** Headers a real browser sends for a typed address, from `ip` as the trusted proxy reports it. */
function browser(ip: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent": CHROME,
    "sec-fetch-dest": "document",
    accept: "text/html,application/xhtml+xml",
    ...(ip === null ? {} : { [TRUSTED_IP_HEADER]: ip }),
    ...extra,
  };
}

function setCookies(reply: Reply): string[] {
  const value = reply.headers["set-cookie"];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** The one thing every "not redirected" case shares: no 307, no Location, no remembered-visit cookie. */
function assertNotRedirected(reply: Reply, label: string) {
  assert.notEqual(reply.status, 307, `${label}: must not be redirected`);
  assert.equal(reply.headers.location, undefined, `${label}: must not carry a Location`);
  assert.equal(
    setCookies(reply).some((cookie) => cookie.startsWith("la_geo_redirected=")),
    false,
    `${label}: must not set the redirect cookie`,
  );
}

/** A visitor who stays on the Vietnamese page gets that page: 200 and `lang="vi"`, not just "no 307". */
function assertServedInVietnamese(reply: Reply, label: string) {
  assertNotRedirected(reply, label);
  assert.equal(reply.status, 200, `${label}: must be served, got ${reply.status}`);
  assert.match(reply.body, /<html[^>]*\blang="vi"/, `${label}: must stay on the Vietnamese page`);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js geo redirect server exited early with code ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const reply = await request("/shop", browser(null));
      if (reply.status < 500) return;
    } catch {
      // Still starting or compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the Next.js geo redirect server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(5_000)]);
  }
}

try {
  await rm(DIST_DIRECTORY, { recursive: true, force: true });
  server = spawn(process.execPath, [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)], {
    env: {
      ...process.env,
      APP_DOMAIN: STOREFRONT_DOMAIN,
      BETTER_AUTH_IP_HEADER: TRUSTED_IP_HEADER,
      NEXT_DIST_DIR: DIST_DIRECTORY,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();

  // --- A first visit from abroad, as an ad click: redirected, query and attribution kept. -------
  const landing = await request(
    "/?utm_source=facebook&utm_campaign=spring&fbclid=IwAR0abc",
    browser(US_IP, { "x-forwarded-proto": "https" }),
  );
  assert.equal(landing.status, 307, "a US first visit to / is a temporary redirect");
  const location = new URL(landing.headers.location ?? "", STOREFRONT_ORIGIN);
  assert.equal(location.pathname, "/en");
  assert.equal(location.search, "?utm_source=facebook&utm_campaign=spring&fbclid=IwAR0abc", "the query rides along");
  if (/^https?:/i.test(landing.headers.location ?? "")) {
    assert.equal(location.origin, STOREFRONT_ORIGIN, "an absolute Location is on the server-owned origin, not this process's");
  }
  assert.equal(landing.headers["cache-control"], "private, no-store");
  const cookies = setCookies(landing);
  const regionCookie = cookies.find((cookie) => cookie.startsWith("la_geo_redirected=1;"));
  assert.ok(regionCookie, `the visit is remembered: ${cookies.join(" | ")}`);
  for (const attribute of ["Path=/", "Max-Age=31536000", "SameSite=Lax", "HttpOnly", "Secure"]) {
    assert.ok(regionCookie.includes(attribute), `cookie carries ${attribute}: ${regionCookie}`);
  }
  assert.ok(
    cookies.some((cookie) => cookie.startsWith("la_utm=")),
    `the ad landing's UTM cookie is written on the redirect itself: ${cookies.join(" | ")}`,
  );
  const plainHttp = await request("/", browser(US_IP));
  assert.equal(plainHttp.status, 307);
  assert.equal(
    setCookies(plainHttp).some((cookie) => /(^|; )Secure/.test(cookie)),
    false,
    "no Secure flag on a plain-HTTP request (local development)",
  );

  // --- The page it lands on renders in English and does not bounce. -----------------------------
  const assertEnglishPage = (reply: Reply, label: string) => {
    assert.equal(reply.status, 200, `${label}: must answer 200, got ${reply.status}`);
    assert.equal(reply.headers.location, undefined, `${label}: must not redirect`);
    assert.match(reply.body, /<html[^>]*\blang="en"/, `${label}: must render in English`);
    // The footer's licence statement is English only on an English page: Vietnamese pages say it in Vietnamese.
    assert.ok(
      reply.body.includes("uses the IP2Location LITE database for"),
      `${label}: must render English interface text`,
    );
  };
  const english = await request(`${location.pathname}${location.search}`, browser(US_IP, { cookie: "la_geo_redirected=1" }));
  assertEnglishPage(english, "/en after the redirect");
  assertEnglishPage(await request("/en/shop", browser(US_IP, { cookie: "la_geo_redirected=1" })), "/en/shop");
  assertEnglishPage(await request("/en", browser(US_IP)), "/en without the cookie (never redirected)");

  // --- A first visit from Vietnam to /en or /en/... goes to the Vietnamese page, query kept. ----
  const vnEnHome = await request(
    "/en?utm_source=google&fbclid=vn123",
    browser(VN_IP, { "x-forwarded-proto": "https" }),
  );
  assert.equal(vnEnHome.status, 307, "a VN first visit to /en is redirected to /");
  const vnHomeLocation = new URL(vnEnHome.headers.location ?? "", STOREFRONT_ORIGIN);
  assert.equal(vnHomeLocation.pathname, "/");
  assert.equal(vnHomeLocation.search, "?utm_source=google&fbclid=vn123");
  const vnCookie = setCookies(vnEnHome).find((cookie) => cookie.startsWith("la_geo_redirected=1;"));
  assert.ok(vnCookie, `VN /en redirect remembers the decision: ${setCookies(vnEnHome).join(" | ")}`);
  assert.ok(
    setCookies(vnEnHome).some((cookie) => cookie.startsWith("la_utm=")),
    "the ad landing's UTM cookie rides along on VN /en redirect too",
  );

  const vnEnSub = await request("/en/shop?page=2", browser(VN_IP, { "x-forwarded-proto": "https" }));
  assert.equal(vnEnSub.status, 307, "a VN first visit to /en/shop drops /en prefix");
  const vnSubLocation = new URL(vnEnSub.headers.location ?? "", STOREFRONT_ORIGIN);
  assert.equal(vnSubLocation.pathname, "/shop");
  assert.equal(vnSubLocation.search, "?page=2");

  assertEnglishPage(
    await request("/en", browser(VN_IP, { cookie: "la_geo_redirected=1" })),
    "VN visitor with cookie stays on /en",
  );
  assertEnglishPage(
    await request("/en/shop", browser(VN_IP, { referer: `http://${HOST}:${PORT}/shop` })),
    "VN visitor who clicked EN on this site stays on /en/shop",
  );
  assertEnglishPage(
    await request("/en", browser("2001:4860:4860::8888")),
    "IPv6 visitor on /en is left on /en",
  );
  assertEnglishPage(
    await request("/en", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", accept: "text/html", [TRUSTED_IP_HEADER]: VN_IP }),
    "Googlebot from VN IP on /en is not redirected",
  );

  // --- Everything that must stay on the Vietnamese page. ----------------------------------------
  assertServedInVietnamese(await request("/", browser(US_IP, { cookie: "la_geo_redirected=1" })), "returning visitor (cookie)");
  assertServedInVietnamese(
    await request("/", browser(US_IP, { referer: `http://${HOST}:${PORT}/en` })),
    "visitor who clicked VI on this site",
  );
  assertServedInVietnamese(await request("/", browser(VN_IP)), "Vietnamese IPv4");
  assertServedInVietnamese(await request("/", browser("2001:4860:4860::8888")), "IPv6 (country unknown)");
  assertServedInVietnamese(await request("/", browser("not-an-ip")), "malformed trusted header");
  assertServedInVietnamese(await request("/", browser(`${US_IP}, 1.1.1.1`)), "multi-value trusted header");
  assertServedInVietnamese(await request("/", browser(null)), "no trusted header at all");
  assertServedInVietnamese(
    await request("/", browser(null, { "x-forwarded-for": US_IP })),
    "X-Forwarded-For alone cannot choose the country",
  );
  assertServedInVietnamese(
    await request("/", browser(VN_IP, { "x-forwarded-for": US_IP, "x-real-ip": US_IP, "cf-ipcountry": "US" })),
    "spoofed forwarding headers cannot override a Vietnamese client IP",
  );
  assertServedInVietnamese(await request("/shop", browser(US_IP)), "other pages are never redirected");
  assertNotRedirected(await request("/shop/ao-dai-1", browser(US_IP)), "product pages are never redirected");

  const previewHeaders = (agent: string) => ({
    "user-agent": agent,
    accept: "text/html",
    [TRUSTED_IP_HEADER]: US_IP,
  });
  for (const agent of [
    "WhatsApp/2.23.18.78 i",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Facebot",
    "Twitterbot/1.0",
    "TelegramBot (like TwitterBot)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Viber",
    "SkypeUriPreview Preview/0.5",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  ]) {
    assertServedInVietnamese(await request("/", previewHeaders(agent)), `preview/crawler agent ${agent}`);
  }
  assertServedInVietnamese(await request("/", { [TRUSTED_IP_HEADER]: US_IP, accept: "text/html" }), "request with no User-Agent");
  assertServedInVietnamese(
    await request("/", browser(US_IP, { "sec-purpose": "prefetch" })),
    "browser prefetch",
  );
  assertServedInVietnamese(
    await request("/", browser(US_IP, { "sec-fetch-dest": "empty", accept: "application/json" })),
    "script fetch",
  );
  assertNotRedirected(await request("/", browser(US_IP), "HEAD"), "HEAD");
  assertNotRedirected(await request("/", browser(US_IP), "POST"), "POST");

  console.log("geo redirect HTTP smoke passed");
} finally {
  await stopServer();
  await rm(DIST_DIRECTORY, { recursive: true, force: true });
}
