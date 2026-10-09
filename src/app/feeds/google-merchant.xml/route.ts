import { createMerchantFeedGetHandler } from "../../../commerce/merchant-feed-http.ts";
import { getMerchantFeed } from "../../../commerce/merchant-feed-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createMerchantFeedGetHandler(getMerchantFeed);