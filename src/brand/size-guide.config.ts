import type { SizeGuideConfig } from "./schema.ts";

const SHARED_SIZES = ["M", "L", "XL", "2XL"] as const;

/**
 * B3/§6 — the size guide facts the owner approved, transcribed.
 *
 * The semantics travel with the numbers:
 * - All measurements are in centimetres (cm).
 * - Chest, waist and hip widths are circumferences around the garment, not flat measurements.
 * - Manufacturing tolerance is ±3 cm.
 * - Height and weight are guidance for size selection only, not a fit guarantee.
 *
 * No size recommendation, size calculator, fit vocabulary or per-product measurement mapping
 * outside these approved tables may be authored or inferred.
 *
 * `charts` is a list rather than the previous fixed `chartA`/`chartB` pair: a brand needs as many
 * tables as it has garment families, and each table carries its own size scale.
 */
export const SIZE_GUIDE: SizeGuideConfig = {
  unit: "cm",
  toleranceCm: 3,
  circumferenceSemanticsNote:
    "Rộng ngực, Rộng eo, Rộng mông là số đo vòng quanh sản phẩm, không phải chiều ngang khi trải phẳng.",
  toleranceNote: "Dung sai sai số may mặc: ±3 cm.",
  guidanceNote:
    "Thông số chiều cao và cân nặng mang tính chất tham khảo chọn size, không bảo đảm vừa vặn tuyệt đối cho mọi vóc dáng.",
  charts: [
    {
      id: "relaxed-and-elastic-waist",
      title: "Sản phẩm dáng rộng / quần lưng chun",
      sizes: SHARED_SIZES,
      rows: [
        {
          parameter: "Rộng ngực (vòng, cm)",
          values: { M: "106", L: "110", XL: "114", "2XL": "118" },
        },
        { parameter: "Dài tay (cm)", values: { M: "55", L: "56", XL: "57", "2XL": "58" } },
        {
          parameter: "Dài áo (cm)",
          values: { M: "63.5", L: "65.5", XL: "67.5", "2XL": "69.5" },
        },
        { parameter: "Dài quần (cm)", values: { M: "105", L: "106", XL: "107", "2XL": "108" } },
        {
          parameter: "Rộng eo — chun (vòng, cm)",
          values: { M: "70–80", L: "74–84", XL: "78–88", "2XL": "82–92" },
        },
        {
          parameter: "Rộng mông (vòng, cm)",
          values: { M: "108", L: "112", XL: "116", "2XL": "120" },
        },
        {
          parameter: "Chiều cao tham khảo",
          values: { M: "1m60–1m85", L: "1m60–1m85", XL: "1m60–1m85", "2XL": "1m60–1m85" },
        },
        {
          parameter: "Cân nặng tham khảo (kg)",
          values: { M: "50–59", L: "60–69", XL: "70–79", "2XL": "80–89" },
        },
      ],
    },
    {
      id: "short-sleeve-tops",
      title: "Áo ngắn tay",
      sizes: SHARED_SIZES,
      rows: [
        {
          parameter: "Rộng ngực (vòng, cm)",
          values: { M: "120", L: "124", XL: "128", "2XL": "132" },
        },
        { parameter: "Dài áo (cm)", values: { M: "63", L: "65", XL: "67", "2XL": "69" } },
        { parameter: "Dài tay (cm)", values: { M: "27", L: "28", XL: "29", "2XL": "30" } },
        {
          parameter: "Chiều cao tham khảo",
          values: { M: "1m60–1m85", L: "1m60–1m85", XL: "1m60–1m85", "2XL": "1m60–1m85" },
        },
        {
          parameter: "Cân nặng tham khảo (kg)",
          values: { M: "50–59", L: "60–69", XL: "70–79", "2XL": "80–89" },
        },
      ],
    },
  ],
};
