import { handleTryOnPost } from "@/commerce/try-on-endpoint";
import { resolveTryOnClientKey, tryOnService } from "@/commerce/try-on-runtime";

/**
 * Virtual try-on generation. All logic is in `@/commerce/try-on-endpoint` and
 * `@/commerce/try-on-service`; this file only binds them to the route. POST only: Next answers any
 * other method with 405.
 */
export async function POST(request: Request) {
  return handleTryOnPost(request, { service: tryOnService, resolveClientKey: resolveTryOnClientKey });
}
