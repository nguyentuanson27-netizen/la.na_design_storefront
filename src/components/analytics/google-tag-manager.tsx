import Script from "next/script";

import { resolveGtmLoad } from "@/integrations/gtm/config";

/**
 * Google Tag Manager container snippet.
 *
 * Runs only when `resolveGtmLoad()` allows it: a valid id, tracking mode not `disabled`, and the
 * container recorded as reviewed in `src/tracking/reviewed-gtm-version.json`. Pushes gtm.start to the shared
 * dataLayer, loads gtm.js after interactive, and provides the noscript iframe fallback.
 */
export function GoogleTagManager() {
  const decision = resolveGtmLoad();
  if (!decision.load) return null;

  return (
    <>
      <Script id="google-tag-manager" strategy="afterInteractive">
        {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer',${JSON.stringify(decision.containerId)});`}
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