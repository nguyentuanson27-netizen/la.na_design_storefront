# Spec — Giá niêm yết hiển thị (List Price Display) v1

Status: **DRAFT v6 — chốt freeze mutation server-side, phân loại giá campaign không hợp lệ, list-price presentation độc lập và JSON-LD pha 4; không có cổng phê duyệt pháp lý riêng cho storefront theo quyết định chủ shop.**

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
5. **Cờ bật/tắt theo từng pha** (§8); rollback pha 2 phải có **fence mutation ở server/database** và xử lý hết campaign % phụ thuộc basis mới trước khi đảo cờ, bảo đảm publish không thể chen vào giữa preflight và chuyển basis. Checkout phải re-quote, đơn đã lưu giữ nguyên snapshot.

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

**Không có trần nâng giá (Q3).** Chủ shop quyết định không đặt trần `list / pos`. Trước rollout chạy audit catalog (mở rộng script kiểu `money:audit`) báo POS nhỏ nhất, tỷ lệ `list / pos`; nếu nằm ngoài dải kỳ vọng **1,2 → 1,5** thì dừng rollout để xem xét.

**Sau khi bật:** sau **mỗi lần đồng bộ catalog Pancake hoàn tất**, chạy audit giá POS mới/thay đổi và báo số lượng + ID biến thể có giá không hợp lệ, `listPriceVnd = null` hoặc tỷ lệ `list / pos > 1,5`; đồng thời chạy audit hằng ngày để không bỏ sót thay đổi. Ví dụ POS **10.000đ → list 49.000đ → badge ~79,6%** phải tạo cảnh báo, không còn là mức giảm 17–33% thông thường. **Cảnh báo không tự đặt trần, không tự sửa giá, không chặn catalog sync**, giá niêm yết vẫn tính theo công thức đã chốt; chủ shop xử lý nội dung/giá sản phẩm khi nhận cảnh báo. Nếu audit hoặc gửi cảnh báo thất bại, ghi lỗi và retry, không âm thầm bỏ qua.

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

**Hợp đồng activation/publish (bắt buộc thực hiện ở pha 2):** `PROMOTION_INVALID` là **lý do tổng hợp của pricing resolver**, không đủ để xác định campaign có thể publish. Activation phải dùng phân loại nội bộ **sau khi kiểm tra input % và theo đúng phép làm tròn 1.000đ**; không bắt buộc đổi enum `PromotionPricingReason` công khai:

| Phân loại nội bộ (dòng PERCENTAGE) | Căn cứ | Kết quả activation |
|---|---|---|
| `THRESHOLD_NOT_MET` | POS/list hợp lệ, tiền tính được là số nguyên dương an toàn, nhưng `campaignPriceVnd >= POS` | **Chỉ cảnh báo** nếu vẫn có ít nhất 1 biến thể giảm thật; dòng đó bán POS |
| `LIST_PRICE_UNAVAILABLE` | POS hợp lệ nhưng `computeListPriceVnd(POS) = null`, ví dụ kết quả list vượt `MAX_SAFE_INTEGER` | **Chặn publish**; không giả làm lỗi POS |
| `NON_POSITIVE_AFTER_ROUNDING` | `campaignPriceVnd <= 0`, ví dụ list 49.000đ, 99% → 0đ | **Chặn publish** dù biến thể khác giảm được |
| `ARITHMETIC_OR_CONFIG_INVALID` | % ngoài 1–99/không nguyên, kết quả không biểu diễn thành tiền an toàn hoặc phép tính thất bại | **Chặn publish**; giữ kiểm tra cấu hình campaign hiện có |
| `BASE_PRICE_UNAVAILABLE` | `isUsableBasePriceVnd(POS)` sai | **Chặn** với `UNUSABLE_BASE_PRICE` như hiện tại |
| `EFFECTIVE` | `0 < campaignPriceVnd < POS`, list hợp lệ | Được tính là biến thể giảm thật |

- **Một phần dưới ngưỡng thuần túy:** `discounted >= 1` và chỉ có thêm `THRESHOLD_NOT_MET` ⇒ **publish thành công kèm warning** (số lượng, ID đã giới hạn và ngưỡng % tối thiểu). Nếu `discounted === 0` nhưng chỉ có `THRESHOLD_NOT_MET`, giữ **chặn `NO_EFFECTIVE_DISCOUNT`**.
- **Bất kỳ lỗi giá không an toàn** (`LIST_PRICE_UNAVAILABLE`, `NON_POSITIVE_AFTER_ROUNDING`, `ARITHMETIC_OR_CONFIG_INVALID`) ⇒ **chặn toàn campaign**, trả lỗi validation có mã/nguyên nhân rõ ràng (`PROMOTION_PRICE_UNSAFE` là failure mới ở activation contract, hoặc mapping lỗi validation có cấu trúc tương đương); không biến lỗi thành warning và không dùng `UNUSABLE_BASE_PRICE` cho POS thực ra hợp lệ.
- `FIXED_PRICE` giữ kiểm tra tiền cố định hiện tại, không bắt buộc có list price để tính tiền; các kiểm tra coverage, overlap, lock, revision và `PROMOTION_CONFLICT` vẫn giữ nguyên.

`validateEffectiveState()` hiện chặn khi `money.invalid.length > 0` và pricing resolver dùng chung `PROMOTION_INVALID` cho nhiều trường hợp. Implementation phải bổ sung phân loại nội bộ dựa trên **kết quả phép tính và trạng thái guard thực tế** (không suy từ `reason` đơn lẻ) rồi kiểm thử cả **kết quả publish thật** và fallback POS cho biến thể không giảm.

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
| Trang đơn hàng / tra cứu đơn / email xác nhận (nếu có) | Hiện giá niêm yết đã đóng băng ở dòng PAID có snapshot, "Bạn đã tiết kiệm" chỉ khi đủ dữ liệu; không tính lại từ POS hiện tại | `src/commerce/guest-order-tracking.ts`, `src/commerce/guest-order-tracking-public-actions.ts`, route/UI tra cứu đơn, `src/routes/order-summary-model.ts`, hai loại snapshot (§6) |
| Feed Google Merchant | `g:price` = giá niêm yết, `g:sale_price` = giá khách trả (giá POS hoặc giá chiến dịch). Bật theo pha riêng, có cờ riêng (§8) | `src/commerce/merchant-offer-mapper.ts`, `src/commerce/merchant-feed-serializer.ts` |
| JSON-LD (structured data) | `Offer.price` = giá thực trả; **chỉ sau GO pha 4** mới thêm `priceSpecification` với `@type: UnitPriceSpecification`, `priceType: https://schema.org/StrikethroughPrice` cho giá tham chiếu (§5.2) | `src/seo/structured-data.ts` |
| Badge `-%` | Hiển thị trên card, PDP, giỏ hàng, tính từ **cùng biến thể** có giá gạch và giá thực trả, `Math.round((1 − giá/giáNiêmYết) × 100)`, ẩn nếu < 1% | **resolver mới** `resolveListPricePresentation` (tách khỏi `resolveStorefrontDiscountPresentation()` hiện tại, §5.1) |

**Không đổi (ngoài phạm vi):** tracking GA4/Meta/Zalo/OpenAI (`value`/`price` vẫn là giá khách trả, không gửi `discount` từ giá niêm yết); giá gửi Pancake; sắp xếp và lọc theo giá (theo giá khách trả); trang `/sale/*` (theo chiến dịch).

### 5.1. Hợp đồng hiển thị list price/badge — pha 1

- **Tách resolver:** xây `resolveListPricePresentation` (hàm thuần ở domain/presentation) nhận một **biến thể đã xác định** có `variantId`, `basePriceVnd` (POS), `effectivePriceVnd` (giá đang trả), `listPriceVnd` (nullable), `isDiscounted` từ promotion projection và trạng thái flag. Trả `referencePriceVnd`, `displayPriceVnd`, `badgePercent`, `variantId`, hoặc `null` khi display OFF/giá không hợp lệ. Tiền gạch, tiền chính và badge phải đều lấy từ **cùng `variantId`**; không tạo resolver giá thứ hai.
- **Validation:** chỉ tạo bộ giá/badge nếu `listPriceVnd > basePriceVnd >= effectivePriceVnd > 0`, đều là safe integer, và tỷ lệ badge sau `Math.round((1 - effective/list) * 100)` >= 1. `listPriceVnd = null` ⇒ fallback hiển thị giá hiện tại theo cách cũ, không dựng badge list giả. `isDiscounted = false` vẫn được có badge giá niêm yết; **không đổi `isDiscounted`**, `promotion`, `/sale/*` hoặc hành vi Flash Sale.
- **Card và PDP chưa chọn biến thể:** chọn chính xác `selectRepresentativeOffers(...).representative` từ tập `offered` đã lọc availability, rồi truyền **toàn bộ bộ ba giá từ biến thể đó** cho resolver. Nếu bề mặt vẫn hiện khoảng giá (range), bộ giá/badge đại diện phải là một cụm riêng có nhãn/biến thể rõ ràng, **không lấy đầu khoảng của A ghép list/badge của B**. Không có đại diện/không có list hợp lệ ⇒ giữ giá/range hiện tại, ẩn list badge. `Từ ...` chỉ dùng khi giá trình bày thực sự là mức thấp nhất trong nhóm biến thể tương ứng. Khi khách chọn biến thể, PDP tính lại toàn bộ bộ ba theo **biến thể được chọn**.
- **Không tái sử dụng nguyên trạng** `resolveStorefrontDiscountPresentation()` cho list badge: helper cũ cố ý lọc `isDiscounted = true` và còn bảo vệ `hasCheaperCurrentVariant` cho campaign thật. Giữ đường này cho trình bày khuyến mãi, không suy trạng thái promotion từ chênh lệch list-vs-POS.
- **Acceptance ví dụ hai biến thể:** A POS 429.000đ / list 549.000đ ⇒ hiển thị 429.000đ và badge **-22%** (không campaign, `isDiscounted=false`); B POS 590.000đ / list 749.000đ ⇒ badge **-21%**. Khi chọn B có campaign 25%, hiển thị 562.000đ và badge **-25%**, `isDiscounted=true`. Không có trường hợp lấy 429.000đ từ A đi với 749.000đ từ B.

### 5.2. Hợp đồng JSON-LD — chỉ triển khai sau GO của pha 4

**Nguồn chuẩn:** [Google Search Central — Merchant listing structured data, Sale pricing](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing). `ListPrice` là một **giá trị `priceType` chuyển tiếp**, không phải `@type`. Dùng `StrikethroughPrice` theo hướng dẫn hiện hành. Mẫu bên dưới là fragment `offers` thuộc `Product` cho **đúng một variant** A có giá POS 429.000đ và list 549.000đ:

```json
{
  "offers": {
    "@type": "Offer",
    "price": 429000,
    "priceCurrency": "VND",
    "priceSpecification": {
      "@type": "UnitPriceSpecification",
      "priceType": "https://schema.org/StrikethroughPrice",
      "price": 549000,
      "priceCurrency": "VND"
    }
  }
}
```

- Giữ các trường `Offer` hiện tại như `url`, `availability` và variant identity; **giá thực trả** ở `Offer.price` không có `priceType`. Khi có chiến dịch thật, `Offer.price` là giá effective của đúng variant. Với `ProductGroup.hasVariant`, mỗi `offers` thuộc **đúng variant của nó**, không đưa giá đại diện của biến thể khác vào node.
- `LIST_PRICE_MERCHANT=OFF`, quyết định **NO-GO**, thiếu bằng chứng giá gốc thực, hoặc `listPriceVnd = null` ⇒ **không thêm** `StrikethroughPrice`; giữ JSON-LD hiện có, không phát ra mệnh đề sale sai sự thật. Không tạo thời hạn `validFrom`/`priceValidUntil` giả; chỉ gắn khi có đợt giảm giá thực với thời điểm đáng tin cậy.
- **Acceptance pha 4:** đối chiếu từng offer/variant giữa JSON-LD, feed, PDP và checkout; validate bản HTML **đã render** bằng [Google Rich Results Test](https://search.google.com/test/rich-results) (và kiểm tra Merchant diagnostics sau rollout GO). Parser hợp lệ **không thay thế** quyết định chính sách GO/NO-GO §7.

## 6. Dữ liệu

- **Catalog:** giá niêm yết không lưu ở bảng catalog, chỉ tính từ `pancakeRetailPrice` bằng hàm thuần (§3) cho bề mặt hiện tại.
- **Schema pha 2:** migration additive thêm `listUnitPriceVnd BigInt?` vào **cả `OrderLineSnapshot` và `OrderQuoteLine`**. Giữ `baseUnitPriceVnd` = giá POS, `unitPriceVnd` = giá thực trả, `lineTotalVnd` = tiền thực trả; không đổi `OrderQuoteDiscountStep`.
- **Snapshot mọi PAID:** kể từ khi bật pha 2, ghi giá niêm yết tại thời điểm re-quote/snapshot cho **mọi dòng `PAID` có giá POS hợp lệ**, kể cả không có chiến dịch %, dùng `FIXED_PRICE`, hoặc có quantity/order-value tier. Việc tính và ghi phải cùng transaction với quote/snapshot từ dữ liệu server, không lấy list price từ client. Nhiều paid segment cùng một variant giữ cùng giá tham chiếu của variant, không cộng lặp giá theo discount steps. Với `GIFT` (giá 0đ), `listUnitPriceVnd = null`.
- **Đọc lịch sử:** chỉ đọc `listUnitPriceVnd` đã đóng băng, không tính lại từ POS/catalog/cờ hiện tại. Không backfill đơn trước pha 2: đơn cũ hoặc tạo trong pha 1 có giá list snapshot `null` nên **không hiển thị giá gạch hoặc tiết kiệm dựa trên list price** ở các dòng đó; nếu bất kỳ paid line nào thiếu tham chiếu, không hiển thị tổng "Bạn đã tiết kiệm" như thể bao phủ cả đơn. Tiền thực trả/khuyến mãi lịch sử giữ nguyên.
- **Quote proof/digest:** list price là **presentation + audit metadata server-side**, không tham gia tính tiền và không được thêm vào `laq2`, `laq3` hay `benefitQuoteDigest` trong v1. Proof hiện tại vẫn ký/kiểm tra giá thực trả, lượng, fulfillment và discount steps; mọi thay đổi giá thật khi đổi basis bắt buộc re-quote và xác nhận lại. Test khẳng định format/digest cũ tương thích; nếu sau này yêu cầu chứng thực cả giá gạch khách đã nhìn thấy, phải thiết kế phiên bản proof riêng thay vì tự ý đổi canonical bytes.
- **Migration/rollback:** hai cột nullable không backfill; immutable history không bị viết lại, rollback giữ nguyên cột và snapshot đã lưu.

### 6.1. Hợp đồng tra cứu đơn công khai — pha 3

- `guest-order-tracking.ts` hiện chỉ trả mã đơn/trạng thái/thời gian/tổng tiền/preorder. Mở rộng server query, `GuestOrderTrackingResult`, view model và UI tra cứu đơn để trả danh sách dòng hàng **giới hạn**: tên sản phẩm, lựa chọn variant, số lượng, `unitPriceVnd`, `lineTotalVnd`, `listUnitPriceVnd` (nullable) và tiết kiệm nếu có đủ dữ liệu. Với benefit quote, hiển thị các PAID segment đúng số tiền nhưng **không nhân đôi** dòng từ `OrderLineSnapshot` và `OrderQuoteLine`; GIFT trình bày riêng và không tính vào tiết kiệm.
- **Auth và an toàn dữ liệu:** chỉ trả chi tiết sau khi khớp **đúng mã đơn và số điện thoại** theo `lookup` hiện có; mã hoặc số sai vẫn trả `NOT_FOUND`, không tiết lộ sự tồn tại của đơn hoặc sản phẩm. Giữ rate limit hiện tại, chỉ trả các field công khai cần thiết, không gửi số điện thoại/token/internal IDs. Không trả chi tiết thiếu cơ sở snapshot ở trạng thái chưa hoàn tất.
- Đơn cũ không có list price vẫn có thể tra trạng thái/tổng tiền, không suy ra giá tham chiếu giả. Test trường hợp đúng/sai mã + số, trạng thái xử lý, đơn đã xác nhận, GIFT, nhiều paid segment và history `null`.

## 7. Vận hành và nội dung

- **Chính sách giá** (`/policies#chinh-sach-gia`): thêm đoạn định nghĩa "Giá niêm yết" và "Giá bán", viết theo sự thật về cách giá niêm yết được xác định. Nội dung do chủ shop duyệt.
- **Admin:** trang sản phẩm hiển thị giá niêm yết tính ra (chỉ đọc) cạnh giá POS, kèm cảnh báo khi guard trả `null`. Không có ghi đè theo từng sản phẩm (Q5, đã bỏ): mọi sản phẩm theo công thức, bật/tắt chỉ bằng cờ toàn cục.
- **Admin chiến dịch (Q7):** chỉ một phần biến thể `THRESHOLD_NOT_MET` ⇒ warning và publish nếu còn biến thể giảm thật; toàn bộ chỉ dưới ngưỡng ⇒ chặn `NO_EFFECTIVE_DISCOUNT`; POS không hợp lệ ⇒ `UNUSABLE_BASE_PRICE`; list price guard `null`, tiền 0 hoặc lỗi số học ⇒ chặn bằng lỗi giá campaign không an toàn (§4).
- **Cache:** feed Merchant dùng cache khóa cố định kèm `promotion pricing revision`. Bật/tắt cờ hoặc đổi công thức phải làm mất hiệu lực cache này, nếu không feed và PDP có thể lệch nhau (đúng loại sai lệch mà test `merchant-feed-pdp-price-parity` đang chặn).
- **Merchant pha 4 có quyết định GO/NO-GO riêng:** chủ shop/người vận hành phê duyệt việc bật `LIST_PRICE_MERCHANT` sau khi kiểm tra bằng chứng **giá gốc đã từng áp dụng**, tính phù hợp với [chính sách `sale_price` của Google](https://support.google.com/merchants/answer/6324471?hl=vi) và [Google Search Central](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing), đồng nhất landing/checkout/feed/JSON-LD, diagnostics và rollback. **Không đáp ứng/không có bằng chứng ⇒ NO-GO:** giữ feed/JSON-LD hiện tại (`g:price` = giá thực trả, không thêm `g:sale_price` hoặc `StrikethroughPrice`). Đây là kiểm soát độc lập cho tích hợp tùy chọn, không tạo cổng pháp lý riêng cho storefront.

## 8. Cờ và pha triển khai

| Cờ (env) | Pha | Phạm vi | Đổi tiền? | Mặc định |
|---|---|---|---|---|
| `LIST_PRICE_DISPLAY` | 1 | card, PDP, giỏ, checkout, badge; không đổi chiến dịch | Không | tắt |
| `LIST_PRICE_CAMPAIGN_BASIS` | 2 | chiến dịch % theo sản phẩm tính trên giá niêm yết; ghi `listUnitPriceVnd` cho mọi PAID ở cả hai loại snapshot; cảnh báo admin | **Có** | tắt, chỉ bật khi `LIST_PRICE_DISPLAY` đã bật |
| `LIST_PRICE_ORDER_HISTORY` | 3 | trang đơn/tra cứu/email hiện giá niêm yết và tiết kiệm | Không | tắt |
| `LIST_PRICE_MERCHANT` | 4 | tùy GO/NO-GO: `g:price`/`g:sale_price`, JSON-LD `UnitPriceSpecification` + `StrikethroughPrice` | Không | tắt |

**Phụ thuộc cờ:** tất cả mặc định OFF. `LIST_PRICE_CAMPAIGN_BASIS=ON` chỉ hợp lệ với `LIST_PRICE_DISPLAY=ON`; không tắt display trước basis. Pha 3 chỉ hiện dữ liệu lịch sử đã đóng băng, kể cả khi basis hiện OFF. Pha 4 là tích hợp riêng, chỉ bật sau quyết định GO và kiểm tra parity. Pha 2 phải bật trước khi tạo campaign % mới dựa trên giá niêm yết. **Không coi đảo cờ pha 2 là rollback an toàn.**

### 8.1. Runbook rollback pha 2 — server-side, chống race

**Điều kiện bắt buộc trước khi cho phép bật pha 2:** phải triển khai **freeze dùng chung tại database**, không chỉ khóa nút admin. Mở rộng hàng `PromotionPricingRevision` với cờ persisted `campaignMutationFrozen` (mặc định `false`) và audit ai/khi nào/rollback id. Mỗi mutation tạo/publish/sửa/copy campaign (`createDraftPromotionCampaign`, `editDraftPromotionCampaign`, `copyPromotionCampaign`, `publishPromotionCampaign`, `editScheduledPromotionCampaign`, và mọi đường ghi tương đương) phải **lấy `lockRevision(tx)` trước khi ghi**, đọc cờ freeze **trong chính transaction đó** rồi fail-closed nếu frozen. Không được có đường ghi bỏ qua service. Lệnh `disablePromotionCampaign` và `endPromotionCampaignEarly` **vẫn được phép** trong lúc freeze, giữ khóa revision và tăng revision khi thay đổi giá. Các đường tạo/sửa Draft trước đây không lấy revision lock cần được cập nhật **thứ tự lock đồng nhất: revision → campaign** nhưng không tăng revision khi chỉ sửa Draft. Test deadlock/order và xem lại lỗi trả về admin (`ACTIVATION_DISABLED` hoặc trạng thái maintenance tương đương).

**`LA_PROMOTION_ACTIVATION_ENABLED=false` là lớp chặn bổ sung**, có thể dùng trong rollout, nhưng code hiện tại chỉ kiểm tra tại `publishPromotionCampaign` và `editScheduledPromotionCampaign`, **không** bảo vệ create/edit/copy Draft; cấu hình env cũng không đổi đồng thời trên các instance. Freeze trong DB mới là nguồn sự thật chống race. Trước rollout phải bảo đảm **mọi web/worker instance đã chạy phiên bản hỗ trợ DB freeze**; instance cũ không được nhận mutation (drain/terminate).

**Quy trình thao tác (basis vẫn ON cho tới bước 4):**

1. **Freeze ở server trước:** transaction lấy `PromotionPricingRevision FOR UPDATE`, đặt `campaignMutationFrozen=true`, commit và ghi audit + revision tại thời điểm freeze. Các publish/edit đã chạy phải kết thúc trước khi transaction freeze lấy được lock; những mutation bắt đầu sau đó phải bị từ chối. Tiếp theo đặt `LA_PROMOTION_ACTIVATION_ENABLED=false` trên mọi instance; xác nhận từ inventory/config health rằng **100% web/worker instance** dùng phiên bản có guard và đã áp dụng cấu hình (không dựa vào nút admin). Nếu không xác minh được, **không tiếp tục rollback**.
2. **Xử lý campaign:** trong khi freeze vẫn giữ, liệt kê tất cả `PERCENTAGE` Active/Scheduled, gồm tương lai; **disable** từng campaign qua service (chỉ dùng chuyển đổi thủ công có chủ shop phê duyệt và giá đã so sánh), thất bại bất kỳ lần nào thì dừng. `FIXED_PRICE` không tự đổi cơ sở nên không phải disable hàng loạt.
3. **Preflight trong trạng thái frozen:** lấy lock revision, kiểm tra cờ vẫn `true`, đọc lại danh sách campaign + giá theo resolver basis OFF; chỉ thông qua nếu **không còn** chiến dịch % Active/Scheduled có thể áp dụng (không chỉ snapshot UI cũ), ghi revision/audit và xác nhận cache invalidated. Khi freeze còn hiệu lực, publish chen vào **không thể commit** sau preflight. Các checkout cũ phải re-quote và đòi xác nhận lại nếu tiền thay đổi; proof giá cũ không được tự dùng.
4. **Đổi basis rồi xác nhận từng instance:** chỉ khi preflight đạt mới chuyển `LIST_PRICE_CAMPAIGN_BASIS=OFF`; xác minh **100% instance đang nhận traffic và worker** đã đọc cờ OFF và cache/revision đã làm mới, kiểm tra PDP/cart/checkout/`/sale/*`/Pancake và Merchant parity nếu áp dụng. **Giữ DB freeze ON trong toàn bộ giai đoạn chuyển cấu hình.** Nếu sai khác/thiếu instance, dừng tiến trình, không mở freeze và không đảo cờ mù.
5. **Mở freeze có kiểm soát:** chỉ sau bước 4 và xác nhận lại không còn campaign % cũ mới đặt `campaignMutationFrozen=false` trong transaction có khóa revision; `LA_PROMOTION_ACTIVATION_ENABLED` chỉ được bật lại nếu chủ shop muốn cho phép publish mới theo basis cũ và **mọi instance** đã áp dụng cấu hình. Đơn/snapshot lịch sử và cột nullable giữ nguyên. Bật lại basis mới cần audit và staging verification tương tự.

**Regression/concurrency bắt buộc:** POS 590.000đ, list 749.000đ, campaign 25%: basis ON **562.000đ**, basis OFF trực tiếp khi campaign còn chạy **442.500đ** (lỗ chênh **119.500đ/đơn vị**, preflight phải từ chối), disable rồi OFF **590.000đ** nếu không ưu đãi khác. Test bằng **hai database client/transaction cạnh tranh**: publish nắm lock trước ⇒ freeze chờ và audit thấy campaign vừa publish; freeze nắm lock trước ⇒ publish bị từ chối, không tăng revision/không tạo hiệu lực; publish sau preflight/trước OFF cũng bị chặn. Test các đường create/edit/copy Draft, Scheduled, disable được phép khi frozen, lock order không deadlock, cache/revision và proof/re-quote. Không được chứng minh điều này chỉ bằng test UI.



## 9. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| **Pháp lý/người tiêu dùng:** giá "gốc" cao hơn giá POS 17–33% nhưng chưa từng được bán ở mức đó. Theo hiểu biết của mình, quy định về thông tin giá, quảng cáo, khuyến mại ở Việt Nam coi giá tham chiếu không có thật là hành vi gây nhầm lẫn. Mình không phải luật sư, cần xác nhận. | **Cao** | Công bố trung thực cách hình thành giá niêm yết, không gọi là giá đã bán trước đây nếu không có bằng chứng; cân nhắc chỉ dùng giá có lịch sử bán thật và theo dõi phản hồi/khiếu nại. |
| **Google Merchant:** gửi `sale_price` với giá gốc chưa từng áp dụng có thể bị coi là sai lệch giá (misrepresentation) và dẫn tới tạm dừng feed hoặc tài khoản. | **Cao** | Pha 4 tách riêng, bật cuối, có cờ. Khuyến nghị cân nhắc bỏ pha 4 vì giá niêm yết không cần có trong feed để website hoạt động. Đọc chính sách Merchant hiện hành trước khi bật. |
| **Meta/Google Ads:** giá hiển thị trên trang đích phải khớp quảng cáo; giảm giá giả có thể vi phạm chính sách quảng cáo. | Trung bình–cao | Tracking vẫn dùng giá khách trả; kiểm tra lại creative có nêu "giảm X%". |
| **Badge phóng đại mức giảm thật:** chiến dịch 25% hiện -25% nhưng khách chỉ rẻ hơn giá thường ~4% (§4). | **Cao** | Admin hiển thị "giảm thật so với giá thường" khi tạo chiến dịch; không dùng con số % của badge trong quảng cáo ngoài website. |
| Chiến dịch % không có tác dụng vì nhỏ hơn ngưỡng (10% không làm giá giảm). | Trung bình | Cảnh báo ở admin trước khi kích hoạt; hiển thị % tối thiểu. |
| Đổi cơ sở tính chiến dịch là thay đổi đường tiền: sai ở đây đổi giá khách trả. | **Cao** | Cờ riêng, test bất biến `giá trả ≤ giá POS`, snapshot `listUnitPriceVnd`, kiểm tra chiến dịch tồn tại trước khi bật, ADR ghi quy tắc cơ sở chiến dịch. |
| **Rollback basis khi campaign % còn Active/Scheduled hoặc publish chen vào giữa preflight/OFF** làm giảm giá ngoài dự kiến (590.000đ → 442.500đ thay vì 562.000đ). | **Cao** | Server-side DB freeze trên `PromotionPricingRevision`, khóa mutation xuyên instance, disable trước, preflight có revision lock, re-quote và xác minh config toàn bộ instance (§8.1). |
| **Catalog sync thêm giá POS thấp**, list/pos và badge vượt dải kỳ vọng (10.000đ → 49.000đ, ~79,6%). | Trung bình–cao | Audit sau mỗi sync + hằng ngày, cảnh báo admin/operator, giữ quyết định không đặt markup cap. |
| Hiệu ứng lệch badge giữa các sản phẩm (17–33%) và hiệu ứng "luôn sale" làm các đợt sale thật kém nổi bật. | Trung bình | Theo dõi conversion trước/sau. |
| Hồi quy tiền tệ do đụng nhiều bề mặt giá. | Trung bình | Test khóa các bất biến ở §10. |
| Lệch feed ↔ PDP ↔ JSON-LD. | Trung bình | Một hàm tính duy nhất; mở rộng test parity; vô hiệu cache khi đổi cờ. |
| Khách khiếu nại/trả hàng vì "giá gốc không đúng". | Trung bình | Chính sách giá rõ ràng; ghi lại số liệu trả hàng/khiếu nại sau khi bật. |

## 10. Kiểm thử

Domain (`tests/domain`):

- `computeListPriceVnd`: ví dụ 565.000 → 699.000; ranh giới đúng bằng mốc (POS 582.500 → target 699.000 → 699.000); POS 1 đồng, 100.000, 250.000, 429.000, số lớn gần `MAX_SAFE_INTEGER`; luôn thỏa `list > pos`, `list ≥ 1,2 × pos` và `list mod 50.000 = 49.000`; đầu vào không hợp lệ.
- Property test: với dải giá POS ngẫu nhiên, số 49/99 trả về là nhỏ nhất thỏa điều kiện.
- **Pha 1 (bất biến tiền):** khi bật/tắt `LIST_PRICE_DISPLAY`, `effectivePriceVnd`, `unitPriceVnd`, `baseUnitPriceVnd`, tổng giỏ, `retail_price` gửi Pancake, giá tracking, snapshot đơn giống hệt nhau; `isDiscounted` không đổi; `/sale/*` chỉ liệt kê sản phẩm có chiến dịch.
- **Pha 1 (presentation):** test `resolveListPricePresentation` có badge khi **không có campaign/isDiscounted=false**; list guard `null` và flag OFF fallback; lựa chọn card/PDP chưa chọn dùng đúng `selectRepresentativeOffers().representative` (availability, tie-break), nhiều biến thể A/B không ghép chéo, chọn lại variant đổi đồng thời gạch/chính/badge; range và `Từ` không đại diện sai mức giá. Giữ test `resolveStorefrontDiscountPresentation()` và `/sale/*` hiện có.
- **Pha 2 (resolver):** `PERCENTAGE` theo sản phẩm tính trên giá niêm yết, làm tròn half-up đến **1.000đ** (749.000 × 75% → 562.000; 549.000 × 75% → 412.000); ranh giới phần dư 500đ (49.000 × 50% → 25.000), kết quả là bội số 1.000đ; resolver vẫn trả `PROMOTION_INVALID` khi kết quả không hợp lệ nhưng **activation phải phân loại nguyên nhân theo §4**; `FIXED_PRICE` không đổi, `PROMOTION_CONFLICT` không xếp vào warning %, `giá trả ≤ giá POS` là property test trên dải giá/percent ngẫu nhiên.
- **Không hồi quy:** khi tắt `LIST_PRICE_CAMPAIGN_BASIS`, chiến dịch % giữ công thức/làm tròn VND cũ; các bậc số lượng/giá trị đơn giữ cách làm tròn half-up đến 1đ của ADR 0016. Test ngưỡng phần trăm nguyên nhỏ nhất có tác dụng sau làm tròn 1.000đ (ví dụ A/B: 22%).
- Bậc số lượng/giá trị đơn và ngưỡng quà: hồi quy toàn bộ test `gift-quantity-*` giữ nguyên; thêm case ngưỡng tính trên giá chiến dịch (sau giảm) chứ không phải giá niêm yết; quà tặng 0đ không đổi.
- Snapshot: ghi `listUnitPriceVnd` ở **mọi PAID có list hợp lệ** từ pha 2, tại `OrderLineSnapshot` và `OrderQuoteLine` kể cả không có campaign; GIFT `null`, paid segment chung variant giữ đúng list; đơn cũ/pha 1 `null`, không backfill; `laq2`/`laq3` và digest không đổi.
- Parity: `g:price`/`g:sale_price`, JSON-LD và PDP khớp nhau cho cùng biến thể, có và không có chiến dịch.
- Tiết kiệm trong giỏ: dòng quà tặng, bậc số lượng, nhiều dòng trộn.
- Admin chiến dịch: cảnh báo đúng số biến thể `THRESHOLD_NOT_MET` và % tối thiểu; **integration test publish** partial valid (POS 565.000đ và 590.000đ, cùng 20%: chỉ 565.000đ giảm thật) ⇒ thành công kèm warning; toàn bộ dưới ngưỡng ⇒ `NO_EFFECTIVE_DISCOUNT`; POS `null` ⇒ `UNUSABLE_BASE_PRICE`; POS **hợp lệ rất lớn** nhưng `listPriceVnd=null` ⇒ **chặn lỗi list riêng**; list 49.000đ/99% làm tròn **0đ** ⇒ chặn; percent/config không hợp lệ ⇒ chặn; không lẫn lộn với `PROMOTION_INVALID` public.
- **Rollback pha 2 (race):** test DB freeze với ít nhất hai transaction cạnh tranh giữa publish và preflight; cả hai thứ tự lock, publish sau preflight trước khi OFF, create/edit/copy Draft, Scheduled, disable/end early khi frozen, toàn bộ instance đổi env, revision/cache và checkout proof. Không được dùng test UI làm bằng chứng khóa mutation.
- **Catalog mới:** sau sync POS 10.000đ sinh list 49.000đ và cảnh báo outlier > 1,5; không chặn sync/đặt cap; audit định kỳ bắt được trường hợp bỏ lỡ post-sync.
- **Tra cứu đơn:** đúng mã + số điện thoại mới thấy dòng hàng; sai từng trường không leak; giữ rate limit; test paid segment, gift, đơn cũ `null`, trạng thái chưa hoàn tất.
- **Merchant:** GO/NO-GO độc lập; NO-GO giữ feed/JSON-LD cũ; GO mới phát `UnitPriceSpecification` có `priceType=StrikethroughPrice`, đúng variant, giá VND khớp PDP/feed/checkout, không tạo thời hạn sale giả; kiểm tra JSON-LD của **HTML render thật** bằng Google Rich Results Test, cache invalidation và test rollback. Không phát `ListPrice` như `@type`.

Trình duyệt (`tests/a11y-runtime`): card, PDP, giỏ trên mobile; nhãn a11y "Giá gốc"/"Giá giảm"; không tràn layout với giá dài.

## 11. Kế hoạch thực hiện

0. Đọc hướng dẫn Next.js trong `node_modules/next/dist/docs/` theo `AGENTS.md` trước khi viết code.
1. **Ghi nhận quyết định:** viết ADR `docs/decisions/0018` (giá niêm yết làm cơ sở chiến dịch % theo sản phẩm, làm tròn đến 1.000đ) và cập nhật `docs/decisions/README.md`.
2. **Audit liên tục:** script kiểm catalog/chiến dịch Active/Scheduled trước rollout, audit sau mỗi Pancake sync + hằng ngày với cảnh báo outlier (§3).
3. **Pha 1, hiển thị (không đổi tiền):** `computeListPriceVnd` + test; thêm `listPriceVnd` vào projection; viết **resolver list-price presentation tách khỏi promotion discount** và dùng `selectRepresentativeOffers()` cho card/PDP chưa chọn (§5.1); model/component card/PDP/giỏ, badge, nhãn a11y; chính sách giá.
4. **Pha 2, cơ sở chiến dịch (đổi tiền):** sửa resolver và **phân loại invalid trong activation** (§4); migration hai cột `listUnitPriceVnd` và **cờ DB `campaignMutationFrozen` tại `PromotionPricingRevision`**; guard mọi mutation campaign với thứ tự lock revision trước campaign, test cạnh tranh với preflight (§8.1); cảnh báo admin, snapshot PAID (§6). Chỉ bật sau khi freeze/runbook đã được kiểm thử.
5. **Pha 3:** trang đơn/email + `guest-order-tracking.ts`, public action, view model và UI tra cứu đơn; phân quyền đúng mã + số và legacy `null` (§6.1).
6. **Pha 4 (tùy chọn, bật cuối):** quyết định GO/NO-GO Merchant (§7); nếu GO mới làm `sale_price` và JSON-LD theo **mẫu `StrikethroughPrice` §5.2**, invalidate cache, parity test và Google Rich Results Test; NO-GO giữ output hiện tại.
7. **Rollout:** staging → mobile → bật dần pha 1 → theo dõi conversion, trả hàng, khiếu nại, Merchant diagnostics → các pha sau.
8. **Rollback:** UI/feed tùy cờ và phụ thuộc; riêng **pha 2 bắt buộc runbook §8.1 trước khi tắt**, hai cột `listUnitPriceVnd` để nguyên.

Ước lượng phải cập nhật khi lập task breakdown: pha 2 nay bao gồm hai loại snapshot, activation và rollback preflight; pha 3 gồm API tra cứu đơn, auth tests và UI; pha 4 là tùy chọn. Không dùng ước lượng cũ làm giới hạn cho quality gate.

## 12. Quyết định

| # | Câu hỏi | Trạng thái |
|---|---|---|
| Q1 | Chiến dịch đang chạy thì tính và hiển thị thế nào? | **Đã chốt:** chiến dịch % tính trên giá niêm yết, làm tròn half-up đến 1.000đ; hiển thị gạch giá niêm yết, giá POS ẩn (§4). Điều kiện kèm theo: chiến dịch chỉ có tác dụng khi giá kết quả < giá POS (xem Q7) |
| Q2 | "Gần nhất kèm sàn, luôn làm tròn lên" chốt là làm tròn lên? | Đang dùng: làm tròn lên (§3); chủ shop không phản đối |
| Q3 | Trần nâng giá (giá thấp)? | **Đã chốt:** không đặt trần; audit trước rollout, sau mỗi sync và định kỳ (§3) |
| Q4 | Giá niêm yết đã từng bán thật ở kênh nào? | **Chưa từng.** Rủi ro về thông tin giá và quảng cáo được ghi nhận tại §9. |
| Q5 | Ghi đè theo từng sản phẩm? | **Đã chốt:** không làm. Mọi sản phẩm theo công thức |
| Q6 | Bậc số lượng / giá trị đơn và ngưỡng quà tính trên giá nào? | **Đã chốt:** giá bán hiện tại (sau giảm giá), đúng như hệ thống đang làm; không đổi, không dùng giá niêm yết (§4) |
| Q7 | Chiến dịch % nhỏ hơn ngưỡng (kết quả ≥ giá POS) xử lý thế nào? | **Diễn giải v1 để triển khai:** chỉ `THRESHOLD_NOT_MET` được cảnh báo khi còn biến thể giảm thật; nếu tất cả chỉ dưới ngưỡng ⇒ chặn `NO_EFFECTIVE_DISCOUNT`; POS lỗi ⇒ `UNUSABLE_BASE_PRICE`; list `null`/kết quả 0/lỗi toán ⇒ chặn, không chỉ cảnh báo (§4) |

