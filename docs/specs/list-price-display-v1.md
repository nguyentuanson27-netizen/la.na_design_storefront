# Spec — Giá niêm yết hiển thị (List Price Display) v1

Status: **DRAFT v4 — các quyết định sản phẩm đã chốt; làm tròn chiến dịch % đến 1.000đ và ghi nhận rủi ro tại §9 mà không đặt cổng phê duyệt riêng.**

Nguồn yêu cầu: chủ shop, phiên làm việc 2026-10-24 → 2026-10-29. Spec này tổng hợp yêu cầu, quyết định đã chốt, hợp đồng kỹ thuật, rủi ro và kế hoạch triển khai. Chưa có dòng code nào được sửa.

## 1. Mục tiêu

Trên website, mỗi sản phẩm hiển thị:

- **Giá gốc (giá niêm yết)**: giá tham chiếu cao hơn, gạch ngang, suy ra từ giá POS theo công thức ở §3.
- **Giá giảm**: chính là giá POS hiện tại, giá mặc định khách thực trả khi không có chiến dịch.
- **Badge `-X%`** cho mức chênh giữa giá niêm yết và giá khách trả.

**Giá niêm yết cũng là giá cơ sở để tính chiến dịch** (Q1): từ nay chiến dịch giảm theo % sẽ tính trên giá niêm yết, không còn tính trên giá POS (xem §4). Hiện chưa có chiến dịch giảm % nào đang chạy trên sản phẩm.

**Không đổi:** giá khách trả khi không có chiến dịch, giá gửi Pancake POS (vẫn là giá khách thực trả của từng dòng), tồn kho, đồng bộ catalog, chiến dịch giá cố định (`FIXED_PRICE`).

## 2. Nguyên tắc kiến trúc

1. **Giá niêm yết là một giá trị suy ra thuần từ giá POS**, `listPriceVnd`, tính bằng một hàm duy nhất (§3). Không có công thức thứ hai ở card, giỏ hàng, feed hay admin. Đây là cùng nguyên tắc `promotion-pricing.ts` đang áp dụng cho giá bán.
2. **Hai khái niệm giá tách bạch trong resolver:**
   - `basePriceVnd` = giá POS = "giá thường": là trần của mọi giá chiến dịch hợp lệ và là giá khách trả khi không có chiến dịch.
   - `campaignBasePriceVnd` = giá niêm yết: là số được nhân với % của chiến dịch giảm theo %.
3. **`isDiscounted` giữ nghĩa "đang có chiến dịch có tác dụng".** Trang `/sale/*`, badge Flash Sale, đồng hồ đếm ngược, `onlyKind` scope đều đọc `isDiscounted`. Giá niêm yết không được làm `isDiscounted = true`, nếu không mọi sản phẩm sẽ thành "đang sale".
4. **Bất biến tiền: giá khách trả ≤ giá POS ở mọi trạng thái.** Giá niêm yết không bao giờ làm tăng số tiền khách trả. Chiến dịch có kết quả ≥ giá POS bị coi là không có tác dụng với biến thể đó (§4).
5. **Có cờ bật/tắt** theo từng pha (§8); tắt cờ trả website về đúng hành vi cũ.

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

**Bảo vệ (guard):** trả về `null` (không hiển thị giá niêm yết, chiến dịch % không có cơ sở tính) khi giá POS không dùng được (`isUsableBasePriceVnd` sai) hoặc kết quả vượt số nguyên an toàn. Sản phẩm có `null` hiển thị một giá như hiện tại.

**Không có trần nâng giá (Q3).** Chủ shop xác nhận không có sản phẩm giá thấp, nên không đặt trần `list / pos`. Để chắc chắn, trước khi bật phải chạy kiểm tra catalog (mở rộng script kiểu `money:audit`) báo giá POS nhỏ nhất và phân bố tỷ lệ `list / pos`; ngoài khoảng 1,2 → 1,5 thì dừng và xem lại.

## 4. Chiến dịch tính trên giá niêm yết

**Quy tắc (Q1, đã chốt):** chiến dịch giảm theo % tính trên giá niêm yết:

```
numerator = BigInt(listPriceVnd) × BigInt(100 − percent)
campaignPriceVnd = ((numerator + 50_000n) / 100_000n) × 1_000n   // BigInt, half-up đến 1.000đ
chiến dịch có tác dụng ⇔ 0 < campaignPriceVnd < giá POS
giá khách trả = campaignPriceVnd nếu có tác dụng, ngược lại giá POS
```

**Quy tắc làm tròn:** `percent` là số nguyên 1–99. Tính chính xác bằng `BigInt`, làm tròn **half-up về bội số 1.000đ gần nhất** (phần dư đúng 500đ làm tròn lên), kiểm tra số nguyên an toàn trước khi chuyển về `number`. Kết quả bằng 0 hoặc vượt miền tiền hợp lệ bị coi là chiến dịch không có tác dụng (`PROMOTION_INVALID`). Quy tắc làm tròn 1.000đ **chỉ áp dụng cho chiến dịch % theo sản phẩm khi `LIST_PRICE_CAMPAIGN_BASIS` bật**; khi tắt cờ, giữ phép tính cũ. Không thay đổi hàm `applyPercentage` hiện tại (half-up đến 1đ) hay cách làm tròn của bậc số lượng/giá trị đơn theo ADR 0016.

- `FIXED_PRICE`: giá cố định không phụ thuộc cơ sở, nên chiến dịch cũ không đổi; vẫn hợp lệ khi giá cố định < giá POS.
- Điều kiện `campaignPrice < giá POS` là **bất biến nên giữ** (§2.4): nếu bỏ, chiến dịch % nhỏ sẽ làm giá bán cao hơn giá thường.
- Chiến dịch không có tác dụng với một biến thể ⇒ biến thể đó hiển thị như không có chiến dịch (lý do `PROMOTION_INVALID`, đúng cơ chế hiện có: chiến dịch vẫn hợp lệ với các biến thể khác).

**Hệ quả cần biết khi đặt chiến dịch %:** vì giá niêm yết cao hơn giá POS 17–33%, một chiến dịch % phải **đủ lớn** mới có tác dụng.

| Ví dụ | POS | Niêm yết | Ngưỡng % tối thiểu | Giảm 10% | Giảm 25% |
|---|---|---|---|---|---|
| A | 590.000 | 749.000 | **22%** | 674.000 → không có tác dụng, khách trả 590.000 | 562.000 (rẻ hơn giá thường 4,7%, badge -25%) |
| B | 429.000 | 549.000 | **22%** | 494.000 → không có tác dụng | 412.000 (rẻ hơn giá thường 4,0%, badge -25%) |

Ví dụ làm tròn: `749.000 × 75% = 561.750 → 562.000đ`; `549.000 × 75% = 411.750 → 412.000đ`. **Ngưỡng % tối thiểu** trong admin là số nguyên nhỏ nhất `p ∈ [1, 99]` sao cho giá sau phép làm tròn 1.000đ thỏa `0 < campaignPriceVnd < giá POS` (không dùng ngưỡng thập phân lý thuyết). Hai ví dụ trên đều có ngưỡng **22%**.

- Badge `-%` luôn so với giá niêm yết, nên chiến dịch 25% hiện **-25%** dù khách chỉ rẻ hơn giá thường vài phần trăm. Đây là điểm rủi ro pháp lý/quảng cáo lớn nhất của thiết kế này (§9).
- **Admin chiến dịch phải cảnh báo** lúc tạo/kích hoạt: "N biến thể không có tác dụng vì giá chiến dịch ≥ giá POS" và hiển thị % nguyên tối thiểu có tác dụng sau làm tròn 1.000đ (mở rộng `promotion-runtime-health.ts`, `promotion-activation-service.ts`, form quản lý chiến dịch).

**Hiển thị:**

| Trạng thái biến thể | Gạch ngang | Giá chính | Badge |
|---|---|---|---|
| Không có chiến dịch có tác dụng, có giá niêm yết | giá niêm yết | giá POS | `-X%` so với giá niêm yết |
| Có chiến dịch có tác dụng | giá niêm yết (giá POS không hiện) | giá chiến dịch | `-Y%` so với giá niêm yết |
| Không có giá niêm yết (guard `null`) | như hiện nay | như hiện nay | như hiện nay |

**Bậc số lượng / giá trị đơn và ngưỡng quà (Q6, đã chốt): không đổi.** Các cơ chế này đã tính trên giá bán hiện tại, tức giá khách thực trả sau mọi giảm giá khác (ADR 0016; ví dụ EX-10: giỏ 1,2tr trước giảm, 960k sau giảm thì không đủ ngưỡng quà 1tr). Giá niêm yết không bao giờ là đầu vào của ngưỡng hay của bậc thang:

- Ngưỡng "đơn từ X đồng" (quà `ORDER_SUBTOTAL`, bậc giá trị đơn) tính trên giá khách trả: giá POS khi không có chiến dịch, giá chiến dịch khi có.
- Bậc số lượng và bậc giá trị đơn theo % chain trên giá bán hiện tại của dòng như hiện nay, không bắt đầu từ giá niêm yết.
- Chỉ **chiến dịch theo sản phẩm** (`PROMOTION`, `FLASH_SALE`, `CLEARANCE`) dùng giá niêm yết làm cơ sở % (quy tắc ở trên). Kết quả của chúng luôn < giá POS nên bất biến đầu vào của bộ máy bậc thang (`legacy.effectivePriceVnd ≤ basePriceVnd`) vẫn đúng và `gift-quantity-*` không phải sửa.

**Chiến dịch đang tồn tại:** chủ shop xác nhận không có chiến dịch % nào đang chạy. Vẫn phải có bước kiểm tra trước khi bật cờ pha 2: liệt kê chiến dịch Active/Scheduled kiểu `PERCENTAGE` theo sản phẩm (kể cả trong tương lai); nếu có thì xử lý trước, vì giá của chúng sẽ đổi (cao lên hoặc mất tác dụng).

## 5. Phạm vi hiển thị (chủ shop chọn "tất cả")

| Bề mặt | Hành vi | File chính (dự kiến) |
|---|---|---|
| Product card (lưới, tìm kiếm, liên quan, home) | Giá niêm yết gạch ngang + giá bán (giá POS hoặc giá chiến dịch) + badge `-%` so với giá niêm yết | `src/components/headless/build-product-card-model.ts`, `src/components/brand/product-card.tsx` |
| Trang sản phẩm (PDP), chọn biến thể | Như bảng §4; badge cập nhật theo biến thể được chọn | `src/components/headless/variant-selection-model.ts`, `src/components/brand/purchase-panel.tsx` |
| Giỏ hàng, drawer, checkout | Mỗi dòng gạch giá niêm yết; dòng "Tiết kiệm" = Σ((giá niêm yết − giá trả) × số lượng); dòng không có giá niêm yết dùng mốc như hiện nay; dòng quà tặng 0đ không tính | `src/routes/line-discount-model.ts`, `src/routes/cart-model.ts`, `src/components/brand/line-price.tsx`, `src/app/cart/page.tsx` |
| Trang đơn hàng / tra cứu đơn / email xác nhận (nếu có) | Hiện giá niêm yết đã đóng băng của từng dòng và "Bạn đã tiết kiệm" | `src/routes/order-summary-model.ts` + snapshot (§6) |
| Feed Google Merchant | `g:price` = giá niêm yết, `g:sale_price` = giá khách trả (giá POS hoặc giá chiến dịch). Bật theo pha riêng, có cờ riêng (§8) | `src/commerce/merchant-offer-mapper.ts`, `src/commerce/merchant-feed-serializer.ts` |
| JSON-LD (structured data) | `Offer.price` giữ giá khách trả; thêm `priceSpecification` loại `ListPrice` cho giá niêm yết | `src/seo/structured-data.ts` |
| Badge `-%` | Hiển thị trên card, PDP, giỏ hàng. Làm tròn `Math.round((1 − giá/giáNiêmYết) × 100)`, ẩn nếu < 1% | dùng chung hàm trong `storefront-discount-presentation.ts` |

**Không đổi (ngoài phạm vi):** tracking GA4/Meta/Zalo/OpenAI (`value`/`price` vẫn là giá khách trả, không gửi `discount` từ giá niêm yết); giá gửi Pancake; sắp xếp và lọc theo giá (theo giá khách trả); trang `/sale/*` (theo chiến dịch).

## 6. Dữ liệu

- **Giá niêm yết không lưu ở bảng catalog.** Nó tính lại từ `pancakeRetailPrice` mỗi lần hiển thị (hàm thuần, rẻ).
- **Snapshot đơn (bắt buộc từ pha 2):** thêm cột nullable `listUnitPriceVnd BigInt?` vào `OrderLineSnapshot` (và dòng quote nếu nó lưu giá cơ sở của chiến dịch theo sản phẩm; xác nhận khi cài đặt). Ghi giá niêm yết đã dùng làm cơ sở tính của dòng đó. Không có nó thì đơn đã giảm theo % không thể tái hiện được số tiền.
- `baseUnitPriceVnd` giữ nghĩa "giá thường (giá POS)"; `unitPriceVnd` vẫn là giá khách trả; `lineTotalVnd` không đổi.
- Migration chỉ thêm cột nullable, không backfill; đơn cũ có `null` và không hiển thị "tiết kiệm".
- Lý do lưu: công thức hoặc cờ có thể đổi sau này; trang đơn đã thanh toán không được tự đổi số.

## 7. Vận hành và nội dung

- **Chính sách giá** (`/policies#chinh-sach-gia`): thêm đoạn định nghĩa "Giá niêm yết" và "Giá bán", viết theo sự thật về cách giá niêm yết được xác định. Nội dung do chủ shop duyệt.
- **Admin:** trang sản phẩm hiển thị giá niêm yết tính ra (chỉ đọc) cạnh giá POS, kèm cảnh báo khi guard trả `null`. Không có ghi đè theo từng sản phẩm (Q5, đã bỏ): mọi sản phẩm theo công thức, bật/tắt chỉ bằng cờ toàn cục.
- **Admin chiến dịch (Q7, đã chốt):** chiến dịch không có tác dụng với một biến thể thì chỉ **cảnh báo** (số biến thể bị ảnh hưởng và % tối thiểu cần có), không chặn kích hoạt (§4).
- **Cache:** feed Merchant dùng cache khóa cố định kèm `promotion pricing revision`. Bật/tắt cờ hoặc đổi công thức phải làm mất hiệu lực cache này, nếu không feed và PDP có thể lệch nhau (đúng loại sai lệch mà test `merchant-feed-pdp-price-parity` đang chặn).

## 8. Cờ và pha triển khai

| Cờ (env) | Pha | Phạm vi | Đổi tiền? | Mặc định |
|---|---|---|---|---|
| `LIST_PRICE_DISPLAY` | 1 | card, PDP, giỏ, checkout, badge; không đổi chiến dịch | Không | tắt |
| `LIST_PRICE_CAMPAIGN_BASIS` | 2 | chiến dịch % theo sản phẩm tính trên giá niêm yết; ghi `listUnitPriceVnd`; cảnh báo admin | **Có** | tắt, chỉ bật khi `LIST_PRICE_DISPLAY` đã bật |
| `LIST_PRICE_ORDER_HISTORY` | 3 | trang đơn/tra cứu/email hiện giá niêm yết và tiết kiệm | Không | tắt |
| `LIST_PRICE_MERCHANT` | 4 | `g:price`/`g:sale_price`, JSON-LD `ListPrice` | Không | tắt |

Mỗi pha bật độc lập, tắt cờ là rollback. Pha 2 phải bật trước khi tạo bất kỳ chiến dịch % nào. Pha 4 bật sau cùng và theo dõi riêng.

## 9. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| **Pháp lý/người tiêu dùng:** giá "gốc" cao hơn giá POS 17–33% nhưng chưa từng được bán ở mức đó. Theo hiểu biết của mình, quy định về thông tin giá, quảng cáo, khuyến mại ở Việt Nam coi giá tham chiếu không có thật là hành vi gây nhầm lẫn. Mình không phải luật sư, cần xác nhận. | **Cao** | Công bố trung thực cách hình thành giá niêm yết, không gọi là giá đã bán trước đây nếu không có bằng chứng; cân nhắc chỉ dùng giá có lịch sử bán thật và theo dõi phản hồi/khiếu nại. |
| **Google Merchant:** gửi `sale_price` với giá gốc chưa từng áp dụng có thể bị coi là sai lệch giá (misrepresentation) và dẫn tới tạm dừng feed hoặc tài khoản. | **Cao** | Pha 4 tách riêng, bật cuối, có cờ. Khuyến nghị cân nhắc bỏ pha 4 vì giá niêm yết không cần có trong feed để website hoạt động. Đọc chính sách Merchant hiện hành trước khi bật. |
| **Meta/Google Ads:** giá hiển thị trên trang đích phải khớp quảng cáo; giảm giá giả có thể vi phạm chính sách quảng cáo. | Trung bình–cao | Tracking vẫn dùng giá khách trả; kiểm tra lại creative có nêu "giảm X%". |
| **Badge phóng đại mức giảm thật:** chiến dịch 25% hiện -25% nhưng khách chỉ rẻ hơn giá thường ~4% (§4). | **Cao** | Admin hiển thị "giảm thật so với giá thường" khi tạo chiến dịch; không dùng con số % của badge trong quảng cáo ngoài website. |
| Chiến dịch % không có tác dụng vì nhỏ hơn ngưỡng (10% không làm giá giảm). | Trung bình | Cảnh báo ở admin trước khi kích hoạt; hiển thị % tối thiểu. |
| Đổi cơ sở tính chiến dịch là thay đổi đường tiền: sai ở đây đổi giá khách trả. | **Cao** | Cờ riêng, test bất biến `giá trả ≤ giá POS`, snapshot `listUnitPriceVnd`, kiểm tra chiến dịch tồn tại trước khi bật, ADR ghi quy tắc cơ sở chiến dịch. |
| Hiệu ứng lệch badge giữa các sản phẩm (17–33%) và hiệu ứng "luôn sale" làm các đợt sale thật kém nổi bật. | Trung bình | Theo dõi conversion trước/sau. |
| Hồi quy tiền tệ do đụng nhiều bề mặt giá. | Trung bình | Test khóa các bất biến ở §10. |
| Lệch feed ↔ PDP ↔ JSON-LD. | Trung bình | Một hàm tính duy nhất; mở rộng test parity; vô hiệu cache khi đổi cờ. |
| Khách khiếu nại/trả hàng vì "giá gốc không đúng". | Trung bình | Chính sách giá rõ ràng; ghi lại số liệu trả hàng/khiếu nại sau khi bật. |

## 10. Kiểm thử

Domain (`tests/domain`):

- `computeListPriceVnd`: ví dụ 565.000 → 699.000; ranh giới đúng bằng mốc (POS 582.500 → target 699.000 → 699.000); POS 1 đồng, 100.000, 250.000, 429.000, số lớn gần `MAX_SAFE_INTEGER`; luôn thỏa `list > pos`, `list ≥ 1,2 × pos` và `list mod 50.000 = 49.000`; đầu vào không hợp lệ.
- Property test: với dải giá POS ngẫu nhiên, số 49/99 trả về là nhỏ nhất thỏa điều kiện.
- **Pha 1 (bất biến tiền):** khi bật/tắt `LIST_PRICE_DISPLAY`, `effectivePriceVnd`, `unitPriceVnd`, `baseUnitPriceVnd`, tổng giỏ, `retail_price` gửi Pancake, giá tracking, snapshot đơn giống hệt nhau; `isDiscounted` không đổi; `/sale/*` chỉ liệt kê sản phẩm có chiến dịch.
- **Pha 2 (resolver):** `PERCENTAGE` theo sản phẩm tính trên giá niêm yết, làm tròn half-up đến **1.000đ** (749.000 × 75% → 562.000; 549.000 × 75% → 412.000); ranh giới phần dư 500đ (49.000 × 50% → 25.000), kết quả là bội số 1.000đ; kết quả ≤ 0 hoặc ≥ giá POS ⇒ `PROMOTION_INVALID`, giá trả = giá POS; `FIXED_PRICE` không đổi; ranh giới đúng bằng giá POS; `PROMOTION_CONFLICT` vẫn về giá thường; `giá trả ≤ giá POS` là property test trên dải giá/percent ngẫu nhiên.
- **Không hồi quy:** khi tắt `LIST_PRICE_CAMPAIGN_BASIS`, chiến dịch % giữ công thức/làm tròn VND cũ; các bậc số lượng/giá trị đơn giữ cách làm tròn half-up đến 1đ của ADR 0016. Test ngưỡng phần trăm nguyên nhỏ nhất có tác dụng sau làm tròn 1.000đ (ví dụ A/B: 22%).
- Bậc số lượng/giá trị đơn và ngưỡng quà: hồi quy toàn bộ test `gift-quantity-*` giữ nguyên; thêm case ngưỡng tính trên giá chiến dịch (sau giảm) chứ không phải giá niêm yết; quà tặng 0đ không đổi.
- Snapshot: `listUnitPriceVnd` được ghi khi cơ sở niêm yết được dùng và tái hiện đúng `unitPriceVnd`; đơn cũ `null`.
- Parity: `g:price`/`g:sale_price`, JSON-LD và PDP khớp nhau cho cùng biến thể, có và không có chiến dịch.
- Tiết kiệm trong giỏ: dòng quà tặng, bậc số lượng, nhiều dòng trộn.
- Admin chiến dịch: cảnh báo đúng số biến thể không có tác dụng và % tối thiểu.

Trình duyệt (`tests/a11y-runtime`): card, PDP, giỏ trên mobile; nhãn a11y "Giá gốc"/"Giá giảm"; không tràn layout với giá dài.

## 11. Kế hoạch thực hiện

0. Đọc hướng dẫn Next.js trong `node_modules/next/dist/docs/` theo `AGENTS.md` trước khi viết code.
1. **Ghi nhận quyết định:** viết ADR `docs/decisions/0018` (giá niêm yết làm cơ sở chiến dịch % theo sản phẩm, làm tròn đến 1.000đ) và cập nhật `docs/decisions/README.md`.
2. **Kiểm tra trước khi bật:** script audit catalog (giá POS nhỏ nhất, phân bố `list / pos`) và liệt kê chiến dịch % theo sản phẩm đang Active hoặc Scheduled.
3. **Pha 1, hiển thị (không đổi tiền):** `computeListPriceVnd` + test; thêm `listPriceVnd` vào kết quả rule giá (`storefront-promotion-projection.ts`, `storefront-product.ts`); model và component card/PDP/giỏ, badge, nhãn a11y; trang chính sách giá.
4. **Pha 2, cơ sở chiến dịch (đổi tiền):** sửa `resolvePromotionPricing` (§4), migration `listUnitPriceVnd`, ghi snapshot, cảnh báo admin chiến dịch; bậc thang giữ nguyên. Có thể làm cùng đợt với pha 1 nhưng cờ riêng.
5. **Pha 3:** trang đơn/tra cứu/email.
6. **Pha 4 (tùy chọn, bật cuối):** Merchant `sale_price`, JSON-LD `ListPrice`, vô hiệu cache, mở rộng parity test.
7. **Rollout:** staging → mobile → bật dần pha 1 → theo dõi conversion, trả hàng, khiếu nại, Merchant diagnostics → các pha sau.
8. **Rollback:** tắt cờ tương ứng; cột `listUnitPriceVnd` để nguyên (additive).

Ước lượng: pha 1 khoảng 10–15 file code + test; pha 2 khoảng 6–10 file (resolver, snapshot, admin chiến dịch, test) và là phần rủi ro nhất; pha 3 vài file; pha 4 3–4 file.

## 12. Quyết định

| # | Câu hỏi | Trạng thái |
|---|---|---|
| Q1 | Chiến dịch đang chạy thì tính và hiển thị thế nào? | **Đã chốt:** chiến dịch % tính trên giá niêm yết, làm tròn half-up đến 1.000đ; hiển thị gạch giá niêm yết, giá POS ẩn (§4). Điều kiện kèm theo: chiến dịch chỉ có tác dụng khi giá kết quả < giá POS (xem Q7) |
| Q2 | "Gần nhất kèm sàn, luôn làm tròn lên" chốt là làm tròn lên? | Đang dùng: làm tròn lên (§3); chủ shop không phản đối |
| Q3 | Trần nâng giá (giá thấp)? | **Đã chốt:** bỏ trần; thay bằng kiểm tra catalog trước khi bật (§3) |
| Q4 | Giá niêm yết đã từng bán thật ở kênh nào? | **Chưa từng.** Rủi ro về thông tin giá và quảng cáo được ghi nhận tại §9. |
| Q5 | Ghi đè theo từng sản phẩm? | **Đã chốt:** không làm. Mọi sản phẩm theo công thức |
| Q6 | Bậc số lượng / giá trị đơn và ngưỡng quà tính trên giá nào? | **Đã chốt:** giá bán hiện tại (sau giảm giá), đúng như hệ thống đang làm; không đổi, không dùng giá niêm yết (§4) |
| Q7 | Chiến dịch % nhỏ hơn ngưỡng (kết quả ≥ giá POS) xử lý thế nào? | **Đã chốt:** không có tác dụng, khách trả giá POS, admin **cảnh báo** (không chặn) |

