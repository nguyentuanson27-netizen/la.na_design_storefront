import Script from "next/script";

import { readOpenAiAdsPixelConfig } from "@/integrations/openai-ads/config";
import { readConsentPolicy } from "@/tracking/consent";

/**
 * ChatGPT Ads Measurement Pixel bootstrap.
 *
 * It is absent when no Pixel ID was supplied at image-build time. Consent is established before
 * init so a future policy change in the existing vendor-neutral consent module applies here too.
 */
export function ChatGptAdsPixel() {
  const config = readOpenAiAdsPixelConfig();
  if (config === null) return null;

  const consentGranted = readConsentPolicy().defaultSignal === "granted";

  return (
    <Script id="chatgpt-ads-pixel" strategy="afterInteractive">
      {`(function(w,d,s,u){if(w.oaiq)return;var q=function(){q.q.push(arguments)};q.q=[];w.oaiq=q;var js=d.createElement(s);js.async=true;js.src=u;var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(js,f)})(window,document,"script","https://bzrcdn.openai.com/sdk/oaiq.min.js");
oaiq("consent", ${JSON.stringify(consentGranted)});
oaiq("init", {pixelId: ${JSON.stringify(config.pixelId)}});`}
    </Script>
  );
}
