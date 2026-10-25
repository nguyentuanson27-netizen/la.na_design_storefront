import { Suspense } from "react";
import Script from "next/script";

import {
  META_VISITOR_ID_COOKIE,
  readMetaFirstPartyCookiesEnabled,
} from "@/integrations/meta/first-party-cookies";
import { readMetaPixelConfig } from "@/integrations/meta/pixel-config";

import { FacebookPixelRouteTracker } from "./facebook-pixel-route-tracker";

/**
 * Meta's standard base snippet. Rendered only when a pixel id is configured, so an unconfigured
 * environment ships no third-party script and the CSP stays closed around it.
 *
 * The route tracker owns both document and SPA PageView so it can share one event ID with CAPI.
 * While `LA_META_FIRST_PARTY_COOKIES_ENABLED` is on, `init` passes the visitor ID the proxy wrote
 * (`la_vid`) as `external_id`, the same value the Conversions API sends, so Meta can tie the browser
 * and server events of one visitor together. Off, `init` never reads it, even from a cookie issued
 * while it was on: a visitor whose first page after the switch is not a storefront page load (so
 * the proxy has not expired it yet) must not keep sending it. The chrome renders per request
 * (`loadSiteChrome` awaits `connection()`), so this reads the runtime value, not the build's.
 *
 * What `init` was given stays on `window.laMetaPixelUserData` and is never rewritten, so a later
 * manual advanced matching update (checkout) can repeat `init` with that base plus only the new
 * shopper's identifiers.
 *
 * The external script's lifecycle is also persisted on the element itself before insertion. A
 * later Purchase effect can therefore distinguish `ready` from `unavailable` even if the one-shot
 * browser load/error event happened before that effect subscribed.
 */
export function FacebookPixel({ nonce }: Readonly<{ nonce?: string }>) {
  const config = readMetaPixelConfig();
  if (config === null) return null;
  const advancedMatching = readMetaFirstPartyCookiesEnabled()
    ? `(function(){
var m=document.cookie.match(/(?:^|; )${META_VISITOR_ID_COOKIE}=([0-9a-f]{64})(?:;|$)/);
return m?{external_id:m[1]}:{}})()`
    : "{}";

  return (
    <>
      <Script id="facebook-pixel" strategy="afterInteractive" nonce={nonce}>
        {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;
t.dataset.laMetaPixelStatus='loading';
t.onload=function(){t.dataset.laMetaPixelStatus=typeof f.fbq==='function'&&typeof f.fbq.callMethod==='function'?'ready':'unavailable'};
t.onerror=function(){t.dataset.laMetaPixelStatus='unavailable'};
s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
window.laMetaPixelUserData=${advancedMatching};
fbq('init', ${JSON.stringify(config.pixelId)}, window.laMetaPixelUserData);`}
      </Script>
      {/* The tracker reads search params, which opts its subtree out of static rendering; the
          boundary keeps that confined to a component that renders nothing. */}
      <Suspense fallback={null}>
        <FacebookPixelRouteTracker />
      </Suspense>
    </>
  );
}
