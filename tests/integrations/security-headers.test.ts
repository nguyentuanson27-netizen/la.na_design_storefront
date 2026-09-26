import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };
type NextConfigLike = { headers?: () => Promise<HeaderRule[]> };

async function loadHeaderRules(cacheBuster = ""): Promise<HeaderRule[]> {
  // next.config.mjs reads the pixel env at module scope, so a second reading needs a fresh module
  // instance rather than the cached one.
  const configUrl = pathToFileURL(resolve("next.config.mjs")).href + cacheBuster;
  const { default: nextConfig } = (await import(configUrl)) as { default: NextConfigLike };

  assert.equal(typeof nextConfig.headers, "function");
  return nextConfig.headers!();
}

async function readCsp(cacheBuster = ""): Promise<string> {
  const rules = await loadHeaderRules(cacheBuster);
  const globalRule = rules.find(({ source }) => source === "/(.*)");
  assert.ok(globalRule);
  const csp = new Map(globalRule.headers.map(({ key, value }) => [key, value])).get(
    "Content-Security-Policy",
  );
  assert.ok(csp);
  return csp;
}

test("Next.js applies the storefront security-header baseline to every route", async () => {
  const rules = await loadHeaderRules();
  const globalRule = rules.find(({ source }) => source === "/(.*)");

  assert.ok(globalRule);

  const headers = new Map(globalRule.headers.map(({ key, value }) => [key, value]));

  assert.equal(headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(
    headers.get("Permissions-Policy"),
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );

  const csp = headers.get("Content-Security-Policy");
  assert.ok(csp);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.match(csp, /img-src\s+[^;]*https:\/\/content\.pancake\.vn/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
});

test("the Pancake chat widget gets exactly its own origins, no wildcard and no eval", async () => {
  const csp = await readCsp("?pancake-chat");
  const directive = (name: string) => csp.match(new RegExp(`${name} ([^;]*)`))?.[1] ?? "";

  assert.match(directive("script-src"), /https:\/\/chat-plugin\.pancake\.vn/);
  assert.match(directive("style-src"), /https:\/\/fonts\.googleapis\.com/);
  assert.match(directive("font-src"), /https:\/\/fonts\.gstatic\.com/);
  assert.match(directive("media-src"), /https:\/\/chat-plugin\.pancake\.vn/);
  assert.match(directive("connect-src"), /https:\/\/pages\.fm wss:\/\/pages\.fm/);
  assert.doesNotMatch(csp, /\*/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
});

test("no pixel configured means no third-party origin is allowed", async () => {
  delete process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID;
  const csp = await readCsp("?no-pixel");

  // An unused allowance for a third-party script origin is a hole with nothing behind it.
  assert.doesNotMatch(csp, /facebook/);
});

test("a configured pixel opens exactly the origins it needs and nothing wider", async () => {
  process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID = "123456789012345";
  try {
    const csp = await readCsp("?with-pixel");

    assert.match(csp, /script-src[^;]*https:\/\/connect\.facebook\.net/);
    assert.match(csp, /img-src[^;]*https:\/\/www\.facebook\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/www\.facebook\.com/);

    // The baseline must survive the additions: still no wildcards, still no eval.
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.doesNotMatch(csp, /\*/);
  } finally {
    delete process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID;
  }
});
