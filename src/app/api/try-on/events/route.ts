import { handleTryOnEventPost } from "@/commerce/try-on-endpoint";
import { emitTryOnSignal } from "@/operations/try-on-observability";

/**
 * Browser-side try-on steps and thumbs, as non-sensitive counters. All logic is in
 * `handleTryOnEventPost`; this file only binds it to the route.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTryOnEventPost(request, { emit: emitTryOnSignal });
}
