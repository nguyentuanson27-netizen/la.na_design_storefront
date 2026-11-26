import assert from "node:assert/strict";
import test from "node:test";

import { lookupCountry, readIpv4 } from "../../src/i18n/geo-country.ts";
import { GEO_REDIRECT_COOKIE, planGeoRedirect } from "../../src/i18n/geo-redirect.ts";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function plan(overrides: Partial<Parameters<typeof planGeoRedirect>[0]> = {}) {
  return planGeoRedirect({
    method: "GET",
    routePath: "/",
    locale: "vi",
    search: "",
    headers: headers({ "user-agent": CHROME, "sec-fetch-dest": "document" }),
    host: "www.lanadesign.vn",
    cookie: undefined,
    country: "US",
    secure: true,
    ...overrides,
  });
}

test("a first visit to the Vietnamese home page from abroad goes to /en and is remembered", () => {
  const result = plan();
  assert.ok(result);
  assert.equal(result.location, "/en");
  assert.ok(result.setCookie.startsWith(`${GEO_REDIRECT_COOKIE}=1;`));
  assert.match(result.setCookie, /Path=\//);
  assert.match(result.setCookie, /SameSite=Lax/);
  assert.match(result.setCookie, /Secure/);
  assert.equal(plan({ secure: false })?.setCookie.includes("Secure"), false);
});

test("the query (ad tags, click ids) travels with the redirect", () => {
  assert.equal(plan({ search: "?utm_source=fb&fbclid=abc" })?.location, "/en?utm_source=fb&fbclid=abc");
});

test("Vietnam stays on Vietnamese pages, and an unknown country never redirects either way", () => {
  assert.equal(plan({ country: "VN" }), null);
  assert.equal(plan({ country: "vn" }), null);
  assert.equal(plan({ country: null }), null);
  assert.equal(plan({ locale: "en", country: null }), null);
  assert.equal(plan({ routePath: "/ao-dai", locale: "en", country: null }), null);
});

test("only the bare home page redirects abroad, while English pages stay English abroad", () => {
  assert.equal(plan({ routePath: "/shop" }), null);
  assert.equal(plan({ routePath: "/shop/ao-dai-1" }), null);
  assert.equal(plan({ locale: "en", country: "US" }), null);
  assert.equal(plan({ routePath: "/ao-dai", locale: "en", country: "US" }), null);
});

test("a first visit to /en or /en/... from Vietnam goes to the Vietnamese equivalent and is remembered", () => {
  const home = plan({ routePath: "/", locale: "en", country: "VN" });
  assert.ok(home);
  assert.equal(home.location, "/");
  assert.ok(home.setCookie.startsWith(`${GEO_REDIRECT_COOKIE}=1;`));

  const subpage = plan({
    routePath: "/ao-dai",
    locale: "en",
    country: "vn",
    search: "?utm_source=fb&fbclid=xyz",
  });
  assert.ok(subpage);
  assert.equal(subpage.location, "/ao-dai?utm_source=fb&fbclid=xyz");

  const product = plan({ routePath: "/shop/ao-dai-1", locale: "en", country: "VN" });
  assert.ok(product);
  assert.equal(product.location, "/shop/ao-dai-1");
});

test("a visitor who was already redirected, or chose a language from the switcher, is left alone", () => {
  assert.equal(plan({ cookie: "1" }), null);
  assert.equal(plan({ locale: "en", country: "VN", cookie: "1" }), null);
  const fromSiteToVi = headers({
    "user-agent": CHROME,
    "sec-fetch-dest": "document",
    referer: "https://www.lanadesign.vn/en",
  });
  assert.equal(plan({ headers: fromSiteToVi }), null);
  const fromSiteToEn = headers({
    "user-agent": CHROME,
    "sec-fetch-dest": "document",
    referer: "https://www.lanadesign.vn/",
  });
  assert.equal(plan({ locale: "en", country: "VN", headers: fromSiteToEn }), null);
  const fromElsewhere = headers({
    "user-agent": CHROME,
    "sec-fetch-dest": "document",
    referer: "https://www.facebook.com/",
  });
  assert.ok(plan({ headers: fromElsewhere }));
  assert.ok(plan({ locale: "en", country: "VN", headers: fromElsewhere }));
});

test("crawlers, link previews, prefetches, scripts and non-GET requests are never redirected", () => {
  for (const agent of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (Linux; Android 11) Chrome/120 Mobile Safari/537.36 Chrome-Lighthouse",
    "curl/8.5.0",
    "WhatsApp/2.23.18.78 i",
    "Viber",
    "Pinterest/0.2 (+http://www.pinterest.com/bot.html)",
    "Google-InspectionTool/1.0",
    "SkypeUriPreview Preview/0.5",
    "",
  ]) {
    assert.equal(plan({ headers: headers({ "user-agent": agent, "sec-fetch-dest": "document" }) }), null, agent);
    assert.equal(
      plan({ locale: "en", country: "VN", headers: headers({ "user-agent": agent, "sec-fetch-dest": "document" }) }),
      null,
      `en-vn-${agent}`,
    );
  }
  // A preview fetcher that sends no Sec-Fetch-Dest and asks for HTML is told apart by its agent alone.
  assert.equal(
    plan({ headers: headers({ "user-agent": "WhatsApp/2.23.18.78 i", accept: "text/html" }), country: "US" }),
    null,
  );
  assert.equal(plan({ headers: headers({ "user-agent": CHROME, "sec-purpose": "prefetch" }) }), null);
  assert.equal(plan({ headers: headers({ "user-agent": CHROME, "sec-fetch-dest": "empty" }) }), null);
  assert.equal(plan({ headers: headers({ "user-agent": CHROME, accept: "application/json" }) }), null);
  assert.equal(plan({ method: "HEAD" }), null);
  assert.equal(plan({ method: "POST" }), null);
  // A browser too old to send Sec-Fetch-Dest is recognised by Accept.
  assert.ok(plan({ headers: headers({ "user-agent": CHROME, accept: "text/html,application/xhtml+xml" }) }));
});

test("lookupCountry reads the table for IPv4 and gives up on everything else", () => {
  assert.equal(lookupCountry("8.8.8.8"), "US");
  assert.equal(lookupCountry("::ffff:8.8.8.8"), "US");
  // Viettel and FPT address space.
  assert.equal(lookupCountry("125.235.0.1"), "VN");
  assert.equal(lookupCountry("2001:4860:4860::8888"), null);
  assert.equal(lookupCountry("10.0.0.1"), null);
  assert.equal(lookupCountry("not-an-ip"), null);
  assert.equal(lookupCountry("999.1.1.1"), null);
  assert.equal(readIpv4("1.2.3.4"), "1.2.3.4");
  assert.equal(readIpv4("::1"), null);
});
