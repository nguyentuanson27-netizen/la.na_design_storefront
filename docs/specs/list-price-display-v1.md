# Spec — Giá niêm yết hiển thị (List Price Display) v1

Status: **DRAFT — chờ chủ shop xác nhận các mục trong "Quyết định còn mở" và cổng pháp lý G0 trước khi code.**

Nguồn yêu cầu: chủ shop, phiên làm việc 2026-10-24 → 2026-10-29. Spec này tổng hợp yêu cầu, quyết định đã chốt, hợp đồng kỹ thuật, rủi ro và kế hoạch triển khai. Chưa có dòng code nào được sửa.

## 1. Mục tiêu

Trên website, mỗi sản phẩm hiển thị:

- **Giá gốc (giá niêm yết)**: giá tham chiếu cao hơn, gạch ngang, suy ra từ giá POS theo công thức ở §3.
- **Giá giảm**: chính là giá POS hiện tại. Đây vẫn là giá khách thực trả, không đổi.
- **Badge `-X%`** cho mức chênh giữa hai giá.

Các chương trình giảm giá (Promotion, Flash Sale, Clearance, bậc số lượng/giá trị đơn) vẫn cấu hình như cũ và được ưu tiên hơn giá niêm yết (xem §4).

**Không đổi:** giá khách thực trả, giá gửi Pancake POS, tồn kho, đồng bộ catalog, logic chiến dịch.

## 2. Nguyên tắc kiến trúc

1. **Giá niêm yết là trường hiển thị riêng, `listPriceVnd`.** Nó suy ra thuần từ giá POS, không bao giờ đi vào `basePriceVnd`, `effectivePriceVnd` hay `isDiscounted`.
2. **Một hàm duy nhất tính giá niêm yết** (§3). Không có công thức thứ hai ở card, giỏ hàng, feed hay admin. Đây là cùng nguyên tắc `promotion-pricing.ts` đang áp dụng cho giá bán.
3. **`isDiscounted` giữ nghĩa "đang có chiến dịch".** Trang `/sale/*`, badge Flash Sale, đồng hồ đếm ngược, `onlyKind` scope đều đọc `isDiscounted`. Nếu giá niêm yết làm `isDiscounted = true` thì mọi sản phẩm sẽ thành "đang sale".
4. **Tiền thật không phụ thuộc giá niêm yết.** Quote, giỏ hàng, checkout, snapshot đơn, `retail_price` gửi Pancake, tracking `value` đều tính từ giá POS và chiến dịch như hiện nay.
5. **Có cờ bật/tắt** toàn cục; tắt cờ trả website về đúng hành vi hiện tại.

## 3. Công thức giá niêm yết

Đơn vị VND, số nguyên. "Đuôi 49, 99" nghĩa là các giá trị dạng `50.000·k − 1.000`: 49.000, 99.000, 149.000, 199.000, ..., 549.000, 599.000, 649.000, 699.000, ...

```
target = ceil(posPrice × 1,2)                       // dùng số nguyên: ceil(posPrice × 12 / 10)
list   = ceil((target + 1000) / 50000) × 50000 − 1000   // số 49/99 nhỏ nhất ≥ target
```

- Ví dụ của chủ shop: POS 565.000 → target 678.000 → **699.000**.
- POS 429.000 → target 514.800 → **549.000** (giảm hiển thị 21,9%).
- POS 590.000 → target 708.000 → **749.000** (giảm hiển thị 21,2%).
- Chỉ dùng số học số nguyên (hoặc `BigInt` như `applyPercentage`), không dùng số thực.

**Cách hiểu yêu cầu làm tròn.** Chủ shop chọn "gần nhất kèm sàn, luôn làm tròn lên". Spec hiểu là: **luôn làm tròn lên** (số 49/99 nhỏ nhất không thấp hơn 1,2 lần giá POS). Cách này tự thỏa sàn: giá niêm yết luôn ≥ 1,2 lần giá POS và luôn lớn hơn giá POS. Nếu ý chủ shop là "gần nhất" (có thể làm tròn xuống), chỉ cần đổi hàm này, các phần còn lại giữ nguyên.

**Hệ quả của làm tròn lên (cần chủ shop biết):** mức giảm hiển thị dao động từ ~17% đến ~33% tùy giá POS (khoảng cách lên mốc 49/99 kế tiếp có thể gần 50.000đ), không đều giữa các sản phẩm.

**Bảo vệ (guard):** trả về `null` (không hiển thị giá niêm yết) khi:

- giá POS không dùng được (`isUsableBasePriceVnd` sai);
- `list / posPrice` vượt `LIST_PRICE_MAX_MARKUP` (mặc định **1,5**), tức giá POS thấp (dưới ~100.000đ) mà nhảy lên mốc 49.000/99.000 quá xa; hoặc
- kết quả vượt số nguyên an toàn.

Sản phẩm có `null` hiển thị như hiện tại, một giá, không badge.

## 4. Tương tác với chương trình giảm giá

**Quy tắc mặc định (cần xác nhận, mục Q1):** khi một biến thể có chiến dịch/bậc giảm đang áp dụng, **giá niêm yết bị ẩn** và việc hiển thị theo đúng cơ chế hiện tại:

| Trạng thái biến thể | Gạch ngang | Giá chính | Badge |
|---|---|---|---|
| Không có chiến dịch, có giá niêm yết | `listPrice` | giá POS | `-X%` (so với `listPrice`) |
| Có chiến dịch hợp lệ | giá POS | giá chiến dịch | `-Y%` (so với giá POS, đúng như hiện nay) |
| Không có giá niêm yết (guard `null`) | không | giá POS | không |

Lý do: chiến dịch tiếp tục tính trên giá POS (không sửa tiền), `/sale/*` vẫn phân biệt được hàng đang sale thật, và badge của chiến dịch phản ánh mức giảm thật thay vì cộng dồn với giá niêm yết.

Các lựa chọn khác đã cân nhắc:

- *Gạch cả hai giá* (niêm yết và POS) khi có chiến dịch: badge phình lên, rủi ro chính sách quảng cáo/pháp lý cao hơn. Không khuyến nghị.
- *Chiến dịch tính trên giá niêm yết*: chiến dịch % nhỏ (ví dụ 10% của 699k = 629k) sẽ cho giá cao hơn giá POS 590k, tức là tăng giá bán. Phải cấu hình lại toàn bộ chiến dịch. Không khuyến nghị.

**Quy tắc bất biến:** `effective price ≤ POS price` ở mọi trạng thái; giá niêm yết không bao giờ làm tăng số tiền khách trả.

## 5. Phạm vi hiển thị (chủ shop chọn "tất cả")

| Bề mặt | Hành vi | File chính (dự kiến) |
|---|---|---|
| Product card (lưới, tìm kiếm, liên quan, home) | Giá niêm yết gạch ngang + giá POS + badge `-%` | `src/components/headless/build-product-card-model.ts`, `src/components/brand/product-card.tsx` |
| Trang sản phẩm (PDP), chọn biến thể | Như bảng §4; badge cập nhật theo biến thể được chọn | `src/components/headless/variant-selection-model.ts`, `src/components/brand/purchase-panel.tsx` |
| Giỏ hàng, drawer, checkout | Mỗi dòng gạch giá niêm yết; dòng "Tiết kiệm" = Σ((giá tham chiếu − giá trả) × số lượng), giá tham chiếu theo §4; dòng quà tặng 0đ không tính | `src/routes/line-discount-model.ts`, `src/routes/cart-model.ts`, `src/components/brand/line-price.tsx`, `src/app/cart/page.tsx` |
| Trang đơn hàng / tra cứu đơn / email xác nhận (nếu có) | Hiện giá niêm yết đã đóng băng của từng dòng và "Bạn đã tiết kiệm" | `src/routes/order-summary-model.ts` + snapshot (§6) |
| Feed Google Merchant | `g:price` = giá niêm yết, `g:sale_price` = giá khách trả (giá POS hoặc giá chiến dịch). Bật theo pha riêng, có cờ riêng (§8) | `src/commerce/merchant-offer-mapper.ts`, `src/commerce/merchant-feed-serializer.ts` |
| JSON-LD (structured data) | `Offer.price` giữ giá khách trả; thêm `priceSpecification` loại `ListPrice` cho giá niêm yết | `src/seo/structured-data.ts` |
| Badge `-%` | Hiển thị trên card, PDP, giỏ hàng. Làm tròn `Math.round((1 − giá/giáNiêmYết) × 100)`, ẩn nếu < 1% | dùng chung hàm trong `storefront-discount-presentation.ts` |

**Không đổi (ngoài phạm vi):** tracking GA4/Meta/Zalo/OpenAI (`value`/`price` vẫn là giá khách trả, không gửi `discount` từ giá niêm yết); giá gửi Pancake; sắp xếp và lọc theo giá (theo giá khách trả); trang `/sale/*` (theo chiến dịch).

## 6. Dữ liệu

- **Giá niêm yết không lưu ở bảng catalog.** Nó tính lại từ `pancakeRetailPrice` mỗi lần hiển thị (hàm thuần, rẻ).
- **Snapshot đơn (để bất biến):** thêm cột nullable `listUnitPriceVnd BigInt?` vào `OrderLineSnapshot`, ghi lúc tạo snapshot khi dòng đó hiển thị giá niêm yết. Migration chỉ thêm cột, không backfill, đơn cũ có `null`. Đơn cũ không hiển thị "tiết kiệm". Thêm cột vào quote snapshot chỉ khi trang đơn đọc từ đó (xác nhận lúc cài đặt).
- Lý do lưu: công thức hoặc cờ có thể đổi sau này; trang đơn đã thanh toán không được tự đổi số.
- Không thay đổi `unitPriceVnd`, `baseUnitPriceVnd`, `lineTotalVnd` và mọi cột tiền khác.

## 7. Vận hành và nội dung

- **Chính sách giá** (`/policies#chinh-sach-gia`): thêm đoạn định nghĩa "Giá niêm yết" và "Giá bán", viết theo sự thật về cách giá niêm yết được xác định (xem G0). Nội dung do chủ shop duyệt.
- **Admin:** trang sản phẩm hiển thị giá niêm yết tính ra (chỉ đọc) cạnh giá POS, kèm cảnh báo khi guard trả `null`. v1 không có ghi đè theo từng sản phẩm (xem Q5).
- **Cache:** feed Merchant dùng cache khóa cố định kèm `promotion pricing revision`. Bật/tắt cờ hoặc đổi công thức phải làm mất hiệu lực cache này, nếu không feed và PDP có thể lệch nhau (đúng loại sai lệch mà test `merchant-feed-pdp-price-parity` đang chặn).

## 8. Cờ và pha triển khai

| Cờ (env) | Phạm vi | Mặc định |
|---|---|---|
| `LIST_PRICE_DISPLAY` | Pha 1: card, PDP, giỏ, checkout, badge | tắt |
| `LIST_PRICE_ORDER_HISTORY` | Pha 2: ghi `listUnitPriceVnd`, trang đơn/email | tắt |
| `LIST_PRICE_MERCHANT` | Pha 3: `g:price`/`g:sale_price`, JSON-LD `ListPrice` | tắt |

Mỗi pha bật độc lập, tắt cờ là rollback. Pha 3 bật sau cùng và theo dõi riêng.

## 9. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| **Pháp lý/người tiêu dùng:** giá "gốc" cao hơn giá POS 17–33% nhưng chưa từng được bán ở mức đó. Theo hiểu biết của mình, quy định về thông tin giá, quảng cáo, khuyến mại ở Việt Nam coi giá tham chiếu không có thật là hành vi gây nhầm lẫn. Mình không phải luật sư, cần xác nhận. | **Cao** | Cổng G0 trước khi bật; câu chữ chính sách giá; ưu tiên bán thật ở giá niêm yết một thời gian hoặc chỉ bật cho sản phẩm có bằng chứng giá cũ (Q4). |
| **Google Merchant:** gửi `sale_price` với giá gốc chưa từng áp dụng có thể bị coi là sai lệch giá (misrepresentation) và dẫn tới tạm dừng feed hoặc tài khoản. | **Cao** | Pha 3 tách riêng, bật cuối, có cờ. Khuyến nghị cân nhắc bỏ pha 3 vì giá niêm yết không cần có trong feed để website hoạt động. Đọc chính sách Merchant hiện hành trước khi bật. |
| **Meta/Google Ads:** giá hiển thị trên trang đích phải khớp quảng cáo; giảm giá giả có thể vi phạm chính sách quảng cáo. | Trung bình–cao | Tracking vẫn dùng giá khách trả; kiểm tra lại creative có nêu "giảm X%". |
| Hiệu ứng lệch badge giữa các sản phẩm (17–33%) và hiệu ứng "luôn sale" làm các đợt sale thật kém nổi bật. | Trung bình | Chiến dịch hiển thị riêng (§4); theo dõi conversion trước/sau. |
| Hồi quy tiền tệ do đụng nhiều bề mặt giá. | Trung bình | Giá niêm yết là trường tách biệt; test khóa các bất biến ở §10. |
| Lệch feed ↔ PDP ↔ JSON-LD. | Trung bình | Một hàm tính duy nhất; mở rộng test parity; vô hiệu cache khi đổi cờ. |
| Khách khiếu nại/trả hàng vì "giá gốc không đúng". | Trung bình | Chính sách giá rõ ràng; ghi lại số liệu trả hàng/khiếu nại sau khi bật. |
| Sản phẩm giá thấp nhảy lên mốc 49.000/99.000 quá xa. | Thấp | Guard `LIST_PRICE_MAX_MARKUP` (§3). |

## 10. Kiểm thử

Domain (`tests/domain`):

- `computeListPriceVnd`: ví dụ 565.000 → 699.000; ranh giới đúng bằng mốc (POS 582.500 → target 699.000 → 699.000); POS 1 đồng, 100.000, 250.000, 429.000, số lớn gần `MAX_SAFE_INTEGER`; luôn thỏa `list > pos`, `list ≥ 1,2 × pos` và `list mod 50.000 = 49.000`; guard markup; đầu vào không hợp lệ.
- Property test: với dải giá POS ngẫu nhiên, số 49/99 trả về là nhỏ nhất thỏa điều kiện.
- Quy tắc §4: chiến dịch hoạt động ⇒ không hiện giá niêm yết; chiến dịch xung đột (`PROMOTION_CONFLICT`) ⇒ hiển thị như không chiến dịch.
- **Bất biến tiền (hồi quy):** `effectivePriceVnd`, `unitPriceVnd`, `baseUnitPriceVnd`, tổng giỏ, `retail_price` gửi Pancake, giá tracking, giá trong snapshot đơn giống hệt khi bật và tắt cờ.
- `isDiscounted` không đổi khi bật cờ; `/sale/*` chỉ liệt kê sản phẩm có chiến dịch.
- Parity: `g:price`/`g:sale_price`, JSON-LD và PDP khớp nhau cho cùng biến thể, có và không có chiến dịch.
- Tiết kiệm trong giỏ: dòng quà tặng, bậc số lượng, nhiều dòng trộn.

Trình duyệt (`tests/a11y-runtime`): card, PDP, giỏ trên mobile; nhãn a11y "Giá gốc"/"Giá giảm"; không tràn layout với giá dài.

## 11. Kế hoạch thực hiện

0. Đọc hướng dẫn Next.js trong `node_modules/next/dist/docs/` theo `AGENTS.md` trước khi viết code.
1. **Chốt:** chủ shop trả lời Q1–Q5 và qua cổng G0; viết ADR `docs/decisions/0018` và cập nhật `docs/decisions/README.md`.
2. **Domain:** `computeListPriceVnd` + test (§3, §10). Thêm `listPriceVnd` vào kết quả của rule giá (`storefront-promotion-projection.ts`, `storefront-product.ts`), tách khỏi `isDiscounted`.
3. **Pha 1 UI:** model card/PDP/giỏ, component, badge, nhãn a11y, trang chính sách giá. Test hồi quy bất biến tiền.
4. **Pha 2:** migration thêm cột, ghi snapshot, trang đơn/email.
5. **Pha 3 (tùy chọn, bật cuối):** Merchant `sale_price`, JSON-LD `ListPrice`, vô hiệu cache, mở rộng parity test.
6. **Rollout:** staging → kiểm tra mobile → bật dần pha 1 → theo dõi conversion, tỷ lệ trả hàng, khiếu nại, Merchant diagnostics → các pha sau.
7. **Rollback:** tắt cờ tương ứng; cột `listUnitPriceVnd` để nguyên (additive).

Ước lượng: pha 1 khoảng 10–15 file code + test, pha 2 một migration nhỏ, pha 3 3–4 file.

## 12. Quyết định còn mở

| # | Câu hỏi | Mặc định trong spec |
|---|---|---|
| Q1 | Chiến dịch đang chạy thì hiển thị giá niêm yết thế nào? | Ẩn giá niêm yết, gạch giá POS, badge theo chiến dịch (§4) |
| Q2 | "Gần nhất kèm sàn, luôn làm tròn lên" chốt là làm tròn lên? | Làm tròn lên (§3) |
| Q3 | Mức guard `LIST_PRICE_MAX_MARKUP` (giá thấp)? | 1,5 |
| Q4 | Giá niêm yết đã từng bán thật ở kênh nào (offline, Shopee, live Facebook...)? | Chưa trả lời; quyết định mức rủi ro G0 |
| Q5 | Cần ghi đè/loại trừ theo từng sản phẩm (cần lưu DB) không? | Không có ở v1 |

**G0 — cổng trước khi bật production:** chủ shop xác nhận cách mô tả giá niêm yết trong chính sách giá và đã tham khảo luật sư/tư vấn pháp lý về việc dùng giá tham chiếu cao hơn giá bán thực tế, đặc biệt cho pha 3 (Merchant).
