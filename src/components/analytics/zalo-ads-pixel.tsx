import Script from "next/script";

import {
  buildZaloAdsPixelScriptSrc,
  readZaloAdsPixelConfig,
} from "@/integrations/zalo-ads/pixel-config";

/**
 * Zalo Ads Pixel: the official snippet's single external tag, nothing else.
 *
 * Absent when no id was supplied at image-build time, so an unconfigured environment never contacts
 * Zalo and the CSP stays closed. There is no inline code and nothing waits on the script, so a
 * blocked or failed load is a no-op for the shopper. The official snippet has no <noscript>
 * fallback and Zalo documents no page-view or event call, so none is invented here: conversions are
 * URL-keyword or button-id rules in the Zalo Ads dashboard (docs/integrations/zalo-ads-pixel.md).
 */
export function ZaloAdsPixel() {
  const config = readZaloAdsPixelConfig();
  if (config === null) return null;

  return <Script id="zalo-ads-pixel" src={buildZaloAdsPixelScriptSrc(config)} strategy="afterInteractive" />;
}
