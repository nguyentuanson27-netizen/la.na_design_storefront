import { createMerchantFeedGetHandler } from "../../../commerce/merchant-feed-http.ts";
import { getFacebookLiveFeed } from "../../../commerce/facebook-live-feed-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createMerchantFeedGetHandler(getFacebookLiveFeed);
