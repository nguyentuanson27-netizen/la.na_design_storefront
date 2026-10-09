import { Suspense } from "react";
import Script from "next/script";

import { readMetaPixelConfig } from "@/integrations/meta/pixel-config";

import { FacebookPixelRouteTracker } from "./facebook-pixel-route-tracker";

/**
 * Meta's standard base snippet. Rendered only when a pixel id is configured, so an unconfigured
 * environment ships no third-party script and the CSP stays closed around it.
 *
 * The route tracker owns both document and SPA PageView so it can share one event ID with CAPI.
 *
 * Loaded `lazyOnload` -- after the page's `load` event, in idle time -- so the library never competes
 * with a phone's first paint or first taps. Nothing is lost by the wait: `facebook-pixel-client`
 * holds every event fired before the snippet runs and hands them over in order, and each browser
 * event has a server-side CAPI twin with the same event ID, so a shopper who leaves before `load`
 * is still counted once.
 *
 * The external script's lifecycle is also persisted on the element itself before insertion. A
 * later Purchase effect can therefore distinguish `ready` from `unavailable` even if the one-shot
 * browser load/error event happened before that effect subscribed.
 */
export function FacebookPixel() {
  const config = readMetaPixelConfig();
  if (config === null) return null;

  return (
    <>
      <Script id="facebook-pixel" strategy="lazyOnload">
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
fbq('init', ${JSON.stringify(config.pixelId)});`}
      </Script>
      {/* The tracker reads search params, which opts its subtree out of static rendering; the
          boundary keeps that confined to a component that renders nothing. */}
      <Suspense fallback={null}>
        <FacebookPixelRouteTracker />
      </Suspense>
    </>
  );
}
