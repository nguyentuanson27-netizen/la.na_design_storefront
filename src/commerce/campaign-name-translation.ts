/**
 * The English for a campaign's name.
 *
 * Campaigns (promotion, gift, shipping, voucher) are named by hand in the admin, in Vietnamese. The
 * name is the key: an admin translates the *text*, so a name several campaigns share is entered once.
 * It is a lookup of its own, never merged into the storefront's catalog: a campaign called "Ưu đãi"
 * must not turn the interface's own "Ưu đãi" into the campaign's English. A campaign without a
 * translation keeps its Vietnamese name; nothing breaks.
 *
 * Pure -- no database -- so the admin form, the repository and the runtime share one definition of
 * what a source and a translation may be.
 */

export const CAMPAIGN_NAME_LOCALES = ["en"] as const;
export type CampaignNameLocale = (typeof CAMPAIGN_NAME_LOCALES)[number];

export const CAMPAIGN_NAME_LIMITS = { source: 300, text: 300 } as const;

/** One campaign name and the English an admin gave it (empty when none). */
export type CampaignNameEntry = Readonly<{ source: string; text: string }>;

/**
 * The name as the campaigns store it: NFC and trimmed. Two spellings of the same Vietnamese (a
 * precomposed and a combining accent) must find the same translation.
 */
export function normalizeCampaignName(value: string): string {
  return value.normalize("NFC").trim();
}

/** A usable name: not empty, not oversized. */
export function isTranslatableCampaignName(source: string): boolean {
  return source.length > 0 && source.length <= CAMPAIGN_NAME_LIMITS.source;
}

export type ParsedCampaignNameInput =
  | Readonly<{ ok: true; value: CampaignNameEntry }>
  | Readonly<{ ok: false; reason: "SOURCE" | "TEXT_TOO_LONG" }>;

/** One row of the admin form. An empty `text` is valid: it means "remove the translation". */
export function parseCampaignNameInput(source: unknown, text: unknown): ParsedCampaignNameInput {
  if (typeof source !== "string") return { ok: false, reason: "SOURCE" };
  const normalizedSource = normalizeCampaignName(source);
  if (!isTranslatableCampaignName(normalizedSource)) return { ok: false, reason: "SOURCE" };
  const normalizedText = typeof text === "string" ? text.normalize("NFC").trim() : "";
  if (normalizedText.length > CAMPAIGN_NAME_LIMITS.text) return { ok: false, reason: "TEXT_TOO_LONG" };
  return { ok: true, value: { source: normalizedSource, text: normalizedText } };
}

/** English campaign names by their Vietnamese text. */
export type CampaignNameMap = Readonly<Record<string, string>>;

/** The lookup for a set of rows: source text to English, unusable rows skipped. */
export function campaignNameMap(rows: readonly CampaignNameEntry[]): CampaignNameMap {
  const names: Record<string, string> = {};
  for (const row of rows) {
    const source = normalizeCampaignName(row.source);
    const text = row.text.trim();
    if (text.length > 0 && isTranslatableCampaignName(source)) names[source] = text;
  }
  return Object.freeze(names);
}

/** A campaign's name for the page: its English when an admin gave one, otherwise the name as written. */
export function localizeCampaignName(names: CampaignNameMap | undefined, name: string): string {
  if (names === undefined) return name;
  const found = names[normalizeCampaignName(name)];
  return found === undefined ? name : found;
}
