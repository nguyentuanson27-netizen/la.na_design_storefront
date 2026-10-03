import { Suspense } from "react";

import {
  buildZaloAdsPixelScriptSrc,
  readZaloAdsPixelConfig,
  readZaloAdsQuarantinePolicy,
} from "@/integrations/zalo-ads/pixel-config";

import { ZaloAdsPixelLoader } from "./zalo-ads-pixel-loader";

/**
 * Zalo Ads Pixel: the official snippet's single external tag, nothing else.
 *
 * Absent when no id was supplied at image-build time, so an unconfigured environment never contacts
 * Zalo and the CSP stays closed. The tag carries only the id; a blocked or failed load is a no-op.
 * The official snippet has no <noscript> fallback and Zalo documents no page-view or event call, so
 * none is invented here: conversions are URL-keyword or button-id rules in the Zalo Ads dashboard
 * (docs/integrations/zalo-ads-pixel.md).
 *
 * The tracker reports the full URL and referrer itself, so the loader decides where it may run and
 * stops it on sensitive URLs. Without the quarantine policy that stopping relies on, it never runs.
 */
export function ZaloAdsPixel() {
  const config = readZaloAdsPixelConfig();
  const quarantinePolicy = readZaloAdsQuarantinePolicy();
  if (config === null || quarantinePolicy === null) return null;

  return (
    // The loader reads search params, which opts its subtree out of static rendering; the boundary
    // keeps that confined to a component that renders nothing.
    <Suspense fallback={null}>
      <ZaloAdsPixelLoader src={buildZaloAdsPixelScriptSrc(config)} quarantinePolicy={quarantinePolicy} />
    </Suspense>
  );
}
