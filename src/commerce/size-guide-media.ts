import {
  isApprovedSizeGuideId,
  type ApprovedSizeGuideId,
} from "../brand/size-guide.config.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { parseTrustedProductImageUrl } from "./product-media.ts";

/**
 * Size-guide artwork, set in admin rather than bundled with the code.
 *
 * The guide's numbers stay in `size-guide.config.ts`; only the picture of them is website-owned
 * content. A guide with no artwork is not broken: the dialog draws the table from that config.
 */

export type SizeGuideMediaErrorCode = "size-guide-unknown" | "size-guide-invalid-image-url";

export class SizeGuideMediaError extends Error {
  readonly code: SizeGuideMediaErrorCode;

  constructor(code: SizeGuideMediaErrorCode) {
    super(code);
    this.name = "SizeGuideMediaError";
    this.code = code;
  }
}

export type SizeGuideMediaInput = Readonly<{
  guideId: ApprovedSizeGuideId;
  /** `null` clears the artwork. */
  imageUrl: string | null;
}>;

/**
 * The URL is held to the same reviewed Pancake CDN contract as every other storefront image, so an
 * admin cannot put an untrusted origin in front of a shopper. Empty means "clear"; a present but
 * untrusted URL is a refusal rather than a silent clear, which would hide the mistake.
 */
export function parseSizeGuideMediaInput(input: unknown): SizeGuideMediaInput {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (!isApprovedSizeGuideId(record.guideId)) {
    throw new SizeGuideMediaError("size-guide-unknown");
  }

  const raw = typeof record.imageUrl === "string" ? record.imageUrl.trim() : record.imageUrl;
  if (raw === undefined || raw === null || raw === "") {
    return Object.freeze({ guideId: record.guideId, imageUrl: null });
  }
  const imageUrl = parseTrustedProductImageUrl(raw);
  if (!imageUrl) throw new SizeGuideMediaError("size-guide-invalid-image-url");
  return Object.freeze({ guideId: record.guideId, imageUrl });
}

export function createSizeGuideMediaRepository(client: PrismaClient) {
  /** The artwork URL for one guide, or `null` when none is set. */
  async function readImageUrl(guideId: ApprovedSizeGuideId): Promise<string | null> {
    const row = await client.sizeGuideMedia.findUnique({
      where: { guideId },
      select: { imageUrl: true },
    });
    return row?.imageUrl ?? null;
  }

  /** Every guide's artwork, keyed by guide id, for the admin page. */
  async function listImageUrls(): Promise<ReadonlyMap<string, string>> {
    const rows = await client.sizeGuideMedia.findMany({
      select: { guideId: true, imageUrl: true },
    });
    return new Map(rows.map((row) => [row.guideId, row.imageUrl]));
  }

  async function save(input: unknown): Promise<SizeGuideMediaInput> {
    const media = parseSizeGuideMediaInput(input);
    if (media.imageUrl === null) {
      await client.sizeGuideMedia.deleteMany({ where: { guideId: media.guideId } });
    } else {
      await client.sizeGuideMedia.upsert({
        where: { guideId: media.guideId },
        create: { guideId: media.guideId, imageUrl: media.imageUrl },
        update: { imageUrl: media.imageUrl },
      });
    }
    return media;
  }

  return { readImageUrl, listImageUrls, save };
}
