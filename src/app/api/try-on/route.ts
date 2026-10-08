import { handleTryOnPost, handleTryOnQuotaGet } from "@/commerce/try-on-endpoint";
import {
  peekTryOnQuota,
  resolveTryOnDisplayIdentity,
  resolveTryOnIdentity,
  tryOnService,
  warmTryOnProvider,
} from "@/commerce/try-on-runtime";

/**
 * Virtual try-on. All logic is in `@/commerce/try-on-endpoint` and `@/commerce/try-on-service`; this
 * file only binds them to the route. POST generates; GET reports the caller's remaining attempts
 * for the day. Next answers any other method with 405.
 */
// Per-shopper: the quota answer must never be built once and served to everyone.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTryOnPost(request, { service: tryOnService, resolveIdentity: resolveTryOnIdentity });
}

export async function GET(request: Request) {
  return handleTryOnQuotaGet(request, {
    resolveIdentity: resolveTryOnDisplayIdentity,
    peekQuota: peekTryOnQuota,
    onAttemptsAvailable: warmTryOnProvider,
  });
}
