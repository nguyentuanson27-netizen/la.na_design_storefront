import { readStorefrontOrigin } from "@/commerce/storefront-origin";
import { createPdpVideoCollector } from "@/operations/pdp-video-collector";

/** Runtime opt-in; same flag as the PDP. Singleton budget per app process, not per request. */
export const POST = createPdpVideoCollector({
  enabled: () => process.env.LA_PDP_PANCAKE_VIDEO_ENABLED === "true",
  origin: () => readStorefrontOrigin(),
  write: (line) => { process.stdout.write(line); },
});
