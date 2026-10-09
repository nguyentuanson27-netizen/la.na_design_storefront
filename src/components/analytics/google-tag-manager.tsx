import Script from "next/script";

import { readGtmConfig } from "@/integrations/gtm/config";

/**
 * Google Tag Manager container snippet.
 *
 * Runs only when a valid GTM container id is configured. Pushes gtm.start to the shared
 * dataLayer, loads gtm.js after interactive, and provides the noscript iframe fallback.
 */
export function GoogleTagManager() {
  const config = readGtmConfig();
  if (config === null) return null;

  return (
    <>
      <Script id="google-tag-manager" strategy="afterInteractive">
        {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer',${JSON.stringify(config.containerId)});`}
      </Script>
      <noscript>
        <iframe
          src={`https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(config.containerId)}`}
          height="0"
          width="0"
          style={{ display: "none", visibility: "hidden" }}
        />
      </noscript>
    </>
  );
}