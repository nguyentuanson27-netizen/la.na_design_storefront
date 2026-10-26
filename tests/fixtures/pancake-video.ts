export const VIDEO_A = "https://content.pancake.vn/videos/2026/10/26/a.mp4";
export const VIDEO_B = VIDEO_A.replace("a.mp4", "b.mp4");
export const VIDEO_POSTER = VIDEO_A.replace(".mp4", ".jpg");
export function videoVariation(id: string, productId: string, videos: unknown) {
  return {
    id, product_id: productId, display_id: id, barcode: id,
    fields: [], images: [VIDEO_POSTER], videos,
    is_hidden: false, is_locked: false,
    retail_price: 500_000, retail_price_after_discount: 450_000,
    product: { id: productId, name: "Video fixture", image: VIDEO_POSTER },
    variations_warehouses: [{ warehouse_id: "video-warehouse", remain_quantity: 4 }],
  };
}
export function videoPage(data: unknown[], overrides = {}) {
  return { success: true, page_number: 1, page_size: 100, total_entries: data.length, total_pages: 1, data, ...overrides };
}
