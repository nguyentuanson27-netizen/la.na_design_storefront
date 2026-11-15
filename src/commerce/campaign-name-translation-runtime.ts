import { prisma } from "../db/prisma.ts";
import { createCampaignNameTranslationRepository } from "./campaign-name-translation-repository.ts";
import { campaignNameMap, type CampaignNameMap } from "./campaign-name-translation.ts";

/**
 * The English names of the campaigns the storefront shows to anyone.
 *
 * Only names of campaigns that are public, switched on and not over are returned (see
 * `readPublic`), because this is what goes to every English visitor's browser: a private voucher's
 * name, a switched-off campaign's and a translation left behind by a renamed one are not. Read on the
 * English storefront only and held in memory for a short while, so an admin's edit shows within the
 * minute rather than at the next deploy. A failed read degrades to "no translations" -- the
 * Vietnamese names -- and is retried after a few seconds.
 */

const repository = createCampaignNameTranslationRepository(prisma);

const FRESH_MS = 30_000;
const RETRY_MS = 5_000;
const EMPTY: CampaignNameMap = Object.freeze({});

let cached: { messages: CampaignNameMap; signature: string; until: number } | null = null;
let inflight: Promise<CampaignNameMap> | null = null;

export async function readPublicCampaignNames(now: number = Date.now()): Promise<CampaignNameMap> {
  if (cached !== null && cached.until > now) return cached.messages;
  inflight ??= (async () => {
    try {
      const rows = await repository.readPublic("en");
      const messages = campaignNameMap(rows);
      const signature = JSON.stringify(Object.entries(messages).sort());
      // The same object while nothing changed, so a client provider's value stays stable.
      const next = cached !== null && cached.signature === signature ? cached.messages : messages;
      cached = { messages: next, signature, until: Date.now() + FRESH_MS };
      return next;
    } catch {
      cached = { messages: cached?.messages ?? EMPTY, signature: cached?.signature ?? "", until: Date.now() + RETRY_MS };
      return cached.messages;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** For the admin save: show the new translation to the next request instead of after the TTL. */
export function forgetPublicCampaignNames(): void {
  cached = null;
}
