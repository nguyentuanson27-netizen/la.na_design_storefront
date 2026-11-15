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
export type CampaignNameKind = "PROMOTION" | "GIFT" | "SHIPPING" | "VOUCHER" | "PRIVATE_VOUCHER";

export type CampaignNameRow = Readonly<{
  source: string;
  /** Which kinds of campaign use this exact name, in a fixed order. */
  kinds: readonly CampaignNameKind[];
  /** The English entered for it, or an empty string. */
  text: string;
  /**
   * Whether the storefront can show it in English. A name only a private voucher carries is never
   * published to the browser, so there is nothing to translate it for.
   */
  translatable: boolean;
}>;

const KIND_ORDER: readonly CampaignNameKind[] = ["PROMOTION", "GIFT", "SHIPPING", "VOUCHER", "PRIVATE_VOUCHER"];

export function createCampaignNameTranslationRepository(db: Db) {
  return {
    /**
     * The English for the names the storefront may show to anyone: those of campaigns that are public,
     * switched on, started and not over, on this shop. A translation whose campaign is private, switched
     * off, not yet started, ended, on another shop, renamed or deleted is not returned, so it can never
     * reach a browser it was not meant for. Promotion and gift campaigns carry no shop of their own (their
     * scope is their targets), so they are read as the rest of the storefront reads them.
     */
    async readPublic(
      locale: CampaignNameLocale,
      shopId: number,
      now: Date = new Date(),
    ): Promise<readonly CampaignNameEntry[]> {
      const running = {
        isEnabled: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      };
      const [promotion, gift, shipping, voucher, translations] = await Promise.all([
        db.promotionCampaign.findMany({ where: running, select: { name: true } }),
        db.giftQuantityCampaign.findMany({ where: running, select: { name: true } }),
        db.shippingPromotionCampaign.findMany({ where: { ...running, pancakeShopId: shopId }, select: { name: true } }),
        db.voucherCampaign.findMany({
          where: { ...running, pancakeShopId: shopId, visibility: "PUBLIC" },
          select: { name: true },
        }),
        db.campaignNameTranslation.findMany({ where: { locale }, select: { source: true, text: true } }),
      ]);
      const shown = new Set<string>();
      for (const { name } of [...promotion, ...gift, ...shipping, ...voucher]) shown.add(normalizeCampaignName(name));
      return translations.filter((row) => shown.has(normalizeCampaignName(row.source)));
    },

    /**
     * Every distinct campaign name in use on this shop, with the English given to it. A translation whose campaign
     * has since been renamed or deleted is not listed: it would be a row nobody can see or reach.
     */
    async listNames(locale: CampaignNameLocale, shopId: number): Promise<readonly CampaignNameRow[]> {
      const [promotion, gift, shipping, voucher, translations] = await Promise.all([
        db.promotionCampaign.findMany({ select: { name: true } }),
        db.giftQuantityCampaign.findMany({ select: { name: true } }),
        db.shippingPromotionCampaign.findMany({ where: { pancakeShopId: shopId }, select: { name: true } }),
        db.voucherCampaign.findMany({ where: { pancakeShopId: shopId }, select: { name: true, visibility: true } }),
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
      add(voucher.filter((row) => row.visibility === "PUBLIC"), "VOUCHER");
      add(voucher.filter((row) => row.visibility !== "PUBLIC"), "PRIVATE_VOUCHER");
      const text = new Map(translations.map((row) => [normalizeCampaignName(row.source), row.text]));
      return [...kinds.entries()]
        .map(([source, set]) => ({
          source,
          kinds: KIND_ORDER.filter((kind) => set.has(kind)),
          text: text.get(source) ?? "",
          // A name carried only by private vouchers is never published, so translating it does nothing.
          translatable: set.size > 1 || !set.has("PRIVATE_VOUCHER"),
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
