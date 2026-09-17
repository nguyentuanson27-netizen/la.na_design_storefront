import { BRAND } from "./brand.config.ts";
import type { SizeGuideConfig } from "./schema.ts";

const NAME = BRAND.identity.name;

/**
 * Master spec §11 — the three approved La.na Design size guides, transcribed.
 *
 * The semantics travel with the numbers:
 * - `Ngực`, `Eo` and `Mông` are circumferences **of the body**, not of the garment. A shopper
 *   measures themselves against these tables; they are not product dimensions.
 * - Body measurements and height are in centimetres; weight is in kilograms. Each row states its
 *   own unit, because one chart carries both.
 * - **No fixed manufacturing tolerance applies**, so `tolerance` is `null`. Brand #1's `±3 cm` was
 *   its own fact, and `0` would be a promise of exact measurements rather than the absence of one.
 * - `set-vay-form-nho` has **no hip row**. The source chart does not provide hip values; §11.3 says
 *   not to invent them, so the chart is four rows and that is its approved shape.
 *
 * A product is mapped to a guide **manually**. Category must not select one, because Set/Váy
 * products may use either the wide-form or the small-form chart; M1 owns that mapping.
 *
 * No size recommendation, size calculator, fit vocabulary or per-product measurement mapping
 * outside these tables may be authored or inferred.
 */
export const SIZE_GUIDE: SizeGuideConfig = {
  unit: "cm",
  tolerance: null,
  circumferenceSemanticsNote:
    "Ngực, eo và mông là số đo vòng cơ thể, không phải số đo trên sản phẩm.",
  guidanceNote: `Bảng size chỉ mang tính tham khảo và có thể thay đổi tùy form dáng của từng sản phẩm; vui lòng liên hệ ${NAME} để được tư vấn chọn size.`,
  charts: [
    {
      id: "ao-dai",
      title: "Áo dài",
      sizes: ["S", "M", "L"],
      rows: [
        { parameter: "Ngực (cm)", values: { S: "86", M: "92", L: "98" } },
        { parameter: "Eo (cm)", values: { S: "62–78", M: "66–82", L: "70–86" } },
        { parameter: "Mông (cm)", values: { S: "96", M: "102", L: "108" } },
        { parameter: "Chiều cao (cm)", values: { S: "153–160", M: "158–165", L: "160–170" } },
        { parameter: "Cân nặng (kg)", values: { S: "43–52", M: "52–62", L: "62–72" } },
      ],
    },
    {
      id: "set-vay-form-rong",
      title: "Set/Váy form rộng",
      sizes: ["S", "M", "L", "XL"],
      rows: [
        { parameter: "Ngực (cm)", values: { S: "86", M: "90", L: "94", XL: "98" } },
        { parameter: "Eo (cm)", values: { S: "62–74", M: "66–78", L: "70–82", XL: "74–88" } },
        { parameter: "Mông (cm)", values: { S: "98", M: "102", L: "106", XL: "110" } },
        {
          parameter: "Chiều cao (cm)",
          values: { S: "155–168", M: "155–168", L: "155–168", XL: "155–168" },
        },
        { parameter: "Cân nặng (kg)", values: { S: "43–51", M: "51–57", L: "57–65", XL: "65–75" } },
      ],
    },
    {
      id: "set-vay-form-nho",
      title: "Set/Váy form nhỏ",
      sizes: ["S", "M", "L", "XL"],
      rows: [
        { parameter: "Ngực (cm)", values: { S: "84", M: "88", L: "92", XL: "96" } },
        { parameter: "Eo (cm)", values: { S: "62–66", M: "66–72", L: "72–76", XL: "76–80" } },
        // No hip row: §11.3 states the source chart does not provide hip values.
        {
          parameter: "Chiều cao (cm)",
          values: { S: "155–168", M: "155–168", L: "155–168", XL: "155–168" },
        },
        { parameter: "Cân nặng (kg)", values: { S: "43–50", M: "50–57", L: "57–64", XL: "64–72" } },
      ],
    },
  ],
};

export const APPROVED_SIZE_GUIDE_IDS = [
  "ao-dai",
  "set-vay-form-rong",
  "set-vay-form-nho",
] as const;

export type ApprovedSizeGuideId = (typeof APPROVED_SIZE_GUIDE_IDS)[number];

export function isApprovedSizeGuideId(value: unknown): value is ApprovedSizeGuideId {
  return (
    typeof value === "string" &&
    (APPROVED_SIZE_GUIDE_IDS as readonly string[]).includes(value)
  );
}

export const APPROVED_SIZE_GUIDES = SIZE_GUIDE.charts.map((chart) => ({
  id: chart.id as ApprovedSizeGuideId,
  title: chart.title,
}));

