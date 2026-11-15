import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  normalizeCampaignName,
  type CampaignNameEntry,
  type CampaignNameLocale,
} from "./campaign-name-translation.ts";

type Db = Pick<
  PrismaClient,
  | "campaignNameTranslation"
  | "promotionCampaign"
  | "giftQuantityCampaign"
  | "shippingPromotionCampaign"
  | "voucherCampaign"
>;

/** Where a campaign name comes from, for the admin list. */
export type CampaignNameKind = "PROMOTION" | "GIFT" | "SHIPPING" | "VOUCHER";

export type CampaignNameRow = Readonly<{
  source: string;
  /** Which kinds of campaign use this exact name, in a fixed order. */
  kinds: readonly CampaignNameKind[];
  /** The English entered for it, or an empty string. */
  text: string;
}>;

const KIND_ORDER: readonly CampaignNameKind[] = ["PROMOTION", "GIFT", "SHIPPING", "VOUCHER"];

export function createCampaignNameTranslationRepository(db: Db) {
  return {
    /** Every stored translation, for the translator. */
    async readAll(locale: CampaignNameLocale): Promise<readonly CampaignNameEntry[]> {
      const rows = await db.campaignNameTranslation.findMany({
        where: { locale },
        select: { source: true, text: true },
      });
      return rows;
    },

    /**
     * Every distinct campaign name in use, with the English given to it. A translation whose campaign
     * has since been renamed or deleted is not listed: it would be a row nobody can see or reach.
     */
    async listNames(locale: CampaignNameLocale): Promise<readonly CampaignNameRow[]> {
      const [promotion, gift, shipping, voucher, translations] = await Promise.all([
        db.promotionCampaign.findMany({ select: { name: true } }),
        db.giftQuantityCampaign.findMany({ select: { name: true } }),
        db.shippingPromotionCampaign.findMany({ select: { name: true } }),
        db.voucherCampaign.findMany({ select: { name: true } }),
        db.campaignNameTranslation.findMany({ where: { locale }, select: { source: true, text: true } }),
      ]);
      const kinds = new Map<string, Set<CampaignNameKind>>();
      const add = (names: readonly { name: string }[], kind: CampaignNameKind) => {
        for (const { name } of names) {
          const source = normalizeCampaignName(name);
          if (source.length === 0) continue;
          const set = kinds.get(source) ?? new Set<CampaignNameKind>();
          set.add(kind);
          kinds.set(source, set);
        }
      };
      add(promotion, "PROMOTION");
      add(gift, "GIFT");
      add(shipping, "SHIPPING");
      add(voucher, "VOUCHER");
      const text = new Map(translations.map((row) => [normalizeCampaignName(row.source), row.text]));
      return [...kinds.entries()]
        .map(([source, set]) => ({
          source,
          kinds: KIND_ORDER.filter((kind) => set.has(kind)),
          text: text.get(source) ?? "",
        }))
        .sort((a, b) => a.source.localeCompare(b.source, "vi"));
    },

    /** Saves one translation; an empty text removes it. */
    async save(entry: CampaignNameEntry, locale: CampaignNameLocale): Promise<void> {
      if (entry.text.length === 0) {
        await db.campaignNameTranslation.deleteMany({ where: { source: entry.source, locale } });
        return;
      }
      await db.campaignNameTranslation.upsert({
        where: { source_locale: { source: entry.source, locale } },
        create: { source: entry.source, locale, text: entry.text },
        update: { text: entry.text },
      });
    },
  };
}
