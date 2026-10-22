import { buildTrackingBootstrapScript } from "@/tracking/bootstrap-script";
import { readTrackingConfig, resolveTrackingRuntime } from "@/tracking/config";
import { readConsentPolicy } from "@/tracking/consent";

/**
 * First-party tracking bootstrap. This loads nothing.
 *
 * It establishes, in document order before any page content, the shared `window.dataLayer`, the
 * pinned `window.la_tracking_mode`, and the Google consent defaults — so a container loaded later
 * finds consent already established rather than measuring ahead of it.
 *
 * No Google Tag Manager container is loaded here and no vendor origin is contacted. The first
 * actual GTM load belongs to the unit that reviews an exact saved container version and opens the
 * Content-Security-Policy for it.
 */
export function TrackingBootstrap({ nonce }: Readonly<{ nonce?: string }>) {
  const runtime = resolveTrackingRuntime(readTrackingConfig());
  if (!runtime.publishesDataLayer) return null;

  return (
    <script
      id="la-tracking-bootstrap"
      nonce={nonce}
      dangerouslySetInnerHTML={{
        __html: buildTrackingBootstrapScript(runtime, readConsentPolicy()),
      }}
    />
  );
}
