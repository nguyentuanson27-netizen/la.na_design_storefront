import Script from "next/script";

import { resolveGtmLoad } from "@/integrations/gtm/config";
import { buildGtmLoaderSnippet } from "@/integrations/gtm/loader-snippet";

/**
 * Google Tag Manager container snippet.
 *
 * Runs only when `resolveGtmLoad()` allows it: a valid id, tracking mode not `disabled`, and the
 * container recorded as reviewed in `src/tracking/reviewed-gtm-version.json`. Pushes gtm.start to the shared
 * dataLayer, loads gtm.js once the shopper first interacts (or a fallback delay after `load`), and
 * provides the noscript iframe fallback.
 *
 * Why it waits: gtm.js pulls in GA4, Google Ads and the TikTok base tag, together well over a
 * megabyte of script that, loaded straight after hydration, competes with the hero photograph for
 * bandwidth and holds the main thread (Total Blocking Time, LCP on a slow phone). Nothing is lost
 * by waiting: `gtm.start` is pushed immediately, and the dataLayer is an array the container
 * replays in order when it arrives, so events published meanwhile are processed, not dropped. The
 * consent defaults live in `TrackingBootstrap` and are unaffected. The cost is a visit that ends
 * before any interaction and before the fallback delay: it is not measured by the container.
 *
 * The snippet is Google's nonce-aware variant: it copies the page's script nonce onto gtm.js, which
 * is how the container's Custom HTML tags get one under a nonce-based policy. The nonce is read
 * when the snippet runs, while the element that carries it is certainly present.
 */
export function GoogleTagManager({ nonce }: Readonly<{ nonce?: string }>) {
  const decision = resolveGtmLoad();
  if (!decision.load) return null;

  return (
    <>
      <Script id="google-tag-manager" strategy="afterInteractive" nonce={nonce}>
        {buildGtmLoaderSnippet(decision.containerId)}
      </Script>
      <noscript>
        <iframe
          src={`https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(decision.containerId)}`}
          height="0"
          width="0"
          style={{ display: "none", visibility: "hidden" }}
        />
      </noscript>
    </>
  );
}