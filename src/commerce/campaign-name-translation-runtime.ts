import { prisma } from "../db/prisma.ts";
import { createCampaignNameTranslationRepository } from "./campaign-name-translation-repository.ts";
import { campaignNameMessages } from "./campaign-name-translation.ts";

/**
 * The English campaign names, ready for the translator.
 *
 * Read on the English storefront only, and held in memory for a short while: a page asks for it
 * several times (the server render, the chrome that serializes the client catalog), and an admin's
 * edit should show within the minute rather than at the next deploy. The same frozen object is
 * handed back until the table changes, so the translator, which compiles its `{slot}` patterns per
 * messages object, compiles once rather than per request. A failed read degrades to "no
 * translations" -- the Vietnamese names -- and is retried on the next call after a few seconds.
 */

const repository = createCampaignNameTranslationRepository(prisma);

const FRESH_MS = 30_000;
const RETRY_MS = 5_000;
const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

let cached: { messages: Readonly<Record<string, string>>; signature: string; until: number } | null = null;
let inflight: Promise<Readonly<Record<string, string>>> | null = null;

export async function readCampaignNameMessages(now: number = Date.now()): Promise<Readonly<Record<string, string>>> {
  if (cached !== null && cached.until > now) return cached.messages;
  inflight ??= (async () => {
    try {
      const rows = await repository.readAll("en");
      const messages = campaignNameMessages(rows);
      const signature = JSON.stringify(Object.entries(messages).sort());
      // The same object while nothing changed, so the translator's compiled patterns stay valid.
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
export function forgetCampaignNameMessages(): void {
  cached = null;
}
