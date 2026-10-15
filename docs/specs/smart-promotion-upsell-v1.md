# SPEC-UPS-001 — Smart Promotion Upsell v1

**Project:** La.na Design Storefront  
**Status:** DRAFT v1.3 — xử lý ba inline findings PR170 ở mức spec (MAC context không lộ cart, giá từng biến thể, re-review PR169 HEAD). U-01/U-02 vẫn chờ owner; U-03/U-05 vẫn cần review kỹ thuật trước `/plan`/`/build`. **Chưa implement**.  
**Revision:** v1.3 (15/10/2026) — review comment closure; giữ nguyên 8 quyết định đã chốt, không tự phê duyệt U-01/U-02.  
**Repository:** `nguyentuanson27-netizen/la.na_design_storefront`  
**Evidence baseline:** `main@4c46488b180acd44481858a8a32f9e848368df24` + PR [#169](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/169) `head@89428fd7ca7543a6dc4c34715dcf80f2a9584fd8` (**open/chưa merge** lúc kiểm tra). PR169 đã có **4 commits mới/17 files thay đổi** so với `c6b11af`, gồm fixes order→order reachability, stage-aware progress, savings và cart/checkout presentation; chỉ kiểm source, không xác nhận runtime.  
**Proposed repo path:** `docs/specs/smart-promotion-upsell-v1.md`  
**Phase:** `/spec` — PR tài liệu độc lập nhắm `main`; việc implement các contract PR169 vẫn phụ thuộc PR169 được review/merge/verify. Không bao gồm `/plan`, `/build` hoặc deploy.

**Quyền quyết định:** D-01…D-08 là yêu cầu owner **đã duyệt**. Những chi tiết đánh dấu **ĐỀ XUẤT / U-01, U-02** không được biến thành approved scope chỉ vì được ghi trong tài liệu hay PR. PR này chỉ đề xuất tiêu chuẩn kỹ thuật và acceptance để người review quyết định, không bật tính năng hay thêm migration.

## 1. Mục tiêu và thước đo

Khi khách có giỏ hàng **gần đạt một mốc khuyến mãi**, checkout chỉ hiển thị **một cơ hội Upsell có chi phí mua thêm thấp nhất** và 3–5 mẫu sản phẩm hợp lệ. Khách có thể chọn phân loại/màu/size và thêm **đúng 1 chiếc** ngay tại checkout. Sau khi thêm, hệ thống tính lại toàn bộ giá, ưu đãi, quà, phí vận chuyển và báo giá được xác thực. Khách có thể bỏ qua mà không bị cản trở đặt hàng.

**Người dùng:** người mua hàng không đăng nhập tại checkout La.na Design; Admin tiếp tục quản lý campaign bằng công cụ hiện có, không có cấu hình Upsell mới trong MVP.

**Thành công về hành vi (acceptance):** mỗi gợi ý xuất hiện đều vượt qua đánh giá read-only của server rằng thêm đúng 1 biến thể được chọn sẽ chạm ngưỡng và **thực sự mở thêm quyền lợi** theo logic đang có; đích thêm hàng không làm mất quote authority hoặc dữ liệu form; nếu dữ liệu đổi thì server từ chối offer cũ an toàn. Không hứa tăng doanh thu định lượng khi chưa có baseline/A-B test.

**KPI quan sát sau rollout (không phải kết quả đã đo):** impression hợp lệ, tỷ lệ click, tỷ lệ add thành công, tỷ lệ đặt hàng sau add, giá trị đơn trước/sau, lỗi/quote-changed và tỷ lệ bỏ checkout. Không suy luận nhân quả từ các số liệu quan sát đơn thuần.

## 2. Nguồn yêu cầu đã xác nhận

| ID | Quyết định từ owner | Trạng thái |
| --- | --- | --- |
| D-01 | Upsell cho mọi chương trình **có mốc gần đạt**: `GIFT_ITEM/QUANTITY`, `GIFT_ITEM/ORDER_SUBTOTAL`, `QUANTITY_TIER` cơ sở `QUANTITY` **và** cơ sở `ORDER_SUBTOTAL` được bổ sung ở PR169. | ĐÃ CHỐT về phạm vi chung; mapping `tierBasis` theo PR169 |
| D-02 | Chỉ gợi ý với mốc số lượng còn thiếu **đúng 1** hoặc mốc tiền đạt **ít nhất 80%, nhưng chưa đạt**. | ĐÃ CHỐT |
| D-03 | Chọn, đổi màu/size và thêm 1 chiếc **ngay trong checkout**, tự cập nhật ưu đãi. | ĐÃ CHỐT |
| D-04 | Ưu tiên 3–5 mẫu hợp lệ, còn hàng, chi phí mua thêm thấp; nếu chỉ có 1–2 mẫu hợp lệ thì hiện đúng số đó, không bù mẫu sai điều kiện. | ĐÃ CHỐT về mục tiêu; fallback kỹ thuật làm rõ |
| D-05 | Khi nhiều campaign gần mốc, chỉ xuất hiện **1 cơ hội có chi phí đạt mốc thấp nhất**. | ĐÃ CHỐT |
| D-06 | Khi khách bỏ qua, ẩn trong lượt thanh toán; chỉ đánh giá hiển thị lại khi **nội dung giỏ thay đổi**. | ĐÃ CHỐT |
| D-07 | **Không gợi ý trùng sản phẩm gốc (`ProductMirror.id`)** đã có trong giỏ, kể cả khác màu/size. | ĐÃ CHỐT |
| D-08 | Chỉ gợi ý biến thể mà **thêm đúng 1 chiếc đạt ưu đãi ngay**. Nếu không có, ẩn toàn bộ Upsell. | ĐÃ CHỐT |

**Ranh giới diễn giải:** `PROMOTION`, `FLASH_SALE`, `CLEARANCE` là giảm giá theo biến thể, không có threshold cần mua thêm; không tạo cơ hội Upsell riêng cho chúng, nhưng **vẫn ảnh hưởng giá/stacking**. Ngưỡng miễn phí vận chuyển không trở thành campaign Upsell độc lập ở v1. Trong PR169, `ORDER_SUBTOTAL` của **`QUANTITY_TIER` là `tierBasis`**, không phải `giftTrigger`, cũng không phải một campaign kind thứ ba. Owner đã duyệt “mọi khuyến mãi gần ngưỡng”, **không** có nghĩa đã duyệt cách triển khai/stacking mới ngoài PR169.

## 3. Bằng chứng codebase và authority

- `src/commerce/gift-quantity-entitlement.ts`: `evaluateGiftEntitlements`, `GiftEntitlement.shortfallToNext`, `earned/entitled/grantable`, `QUANTITY`, `ORDER_SUBTOTAL`, `ONCE/REPEAT_PER_THRESHOLD`.
- `src/commerce/gift-quantity-tier.ts`: bậc số lượng và (PR169) bậc **giá trị đơn** với `tierBasis = QUANTITY | ORDER_SUBTOTAL`, `FIXED_AMOUNT_TOTAL_VND`, xử lý chia discount vào paid segments; invalid tier bị loại nguyên bước. `QuantityTier.minQuantity` trong DB lưu **số chiếc hoặc VND tùy basis**, tuyệt đối không suy luận từ tên cột.
- `src/commerce/gift-quantity-scope.ts`: `DYNAMIC_CATEGORY`, `FIXED_PRODUCT_SET`, exclude thắng. Theo PR169, `QUANTITY_TIER/ORDER_SUBTOTAL` **bắt buộc** `GLOBAL_ALL_PAID_LINES`; gift theo subtotal có thể toàn giỏ hoặc scope đủ điều kiện như hợp đồng của gift; tier số lượng có scope sản phẩm thực.
- `src/commerce/gift-quantity-stack.ts`, `gift-quantity-quote.ts`, `storefront-cart-repository.ts`: stacking, paid quote, flag. PR169 HEAD mới giải quyết **reachability nhiều order-value ladders theo (priority, id)**, rerun stack khi campaign bị loại và đọc `orderValueProgress.currentVnd` ngay trước **ladder đang xét** (không nhầm giá bị ladder chạy sau giảm). `orderValueProgress` vẫn chỉ dùng cho display/hints, **không** xác nhận candidate +1 cụ thể.
- `src/commerce/cart-gift-selection.ts`, `src/routes/cart-gift-model.ts`, `src/components/brand/cart-gift-picker.tsx`: lưu và xác thực lựa chọn quà; picker hiện nằm ở `/cart`.
- `src/routes/checkout.ts`, `src/routes/checkout-model.ts`, `src/app/checkout/page.tsx`, `src/components/commerce/guest-checkout-form.tsx`: route/model/render và biểu mẫu checkout. PR169 đặt `PromotionBanner` **trên** checkout nhưng `buildCheckoutPromotionView` chỉ quảng bá ưu đãi **đã đạt**, không đưa next-milestone vào checkout; đây là thiết kế PR169 cần giữ tách biệt với `CheckoutUpsell`.
- `src/commerce/benefit-checkout-quote.ts`, `benefit-checkout-render.ts`, `checkout-quote-proof.ts`, `guest-checkout-submit-runtime.ts`: quote/proof và bước xác nhận lại khi quote thay đổi.
- `src/commerce/storefront-actions.ts`, `storefront-purchase-public-actions.ts`, `anonymous-cart-mutation.ts`: precedent cho thêm **1 chiếc** và analytics từ mutation đã commit; không dùng giá truyền từ browser.
- `src/commerce/gift-quantity-gate.ts`, `pancake-line-level-contract.ts`: Gift/Quantity gate mặc định OFF; benefit checkout, bao gồm **đơn sau khi Upsell mở order-value tier**, phụ thuộc bằng chứng line-level POS theo shop.
- PR169 thêm `src/routes/cart-promotion-model.ts`, `src/components/brand/promotion-banner.tsx`, `src/routes/order-summary-model.ts`, `src/components/brand/order-summary.tsx` và `getStorefrontCartView`. HEAD mới reconcile tier saving theo **listed price** khi tier/Flash Sale chạy nhiều thứ tự và checkout summary kiểm cả listed-value/total; đây là presentation/read-model, không phải quote authority.
- Nguồn nghiệp vụ ưu tiên: `docs/specs/gift-quantity-promotions-v1.md`, `docs/decisions/0016-gift-quantity-promotions-v1-decisions.md`, `docs/specs/la-na-design-master-spec.md`; trong **PR169**, ADR 0016 được thêm D-11…D-13 cho order-value ladder. Các quyết định này còn ở nhánh PR cho tới khi merge; không diễn giải là authority đã nằm trên `main`. Không thay tài liệu bằng suy đoán từ mockup.

**Stack đọc từ `package.json` tại baseline:** Next.js `16.3.3`, React `19.2.0`, TypeScript `^5.9.0`, Prisma `7.9.1`, PostgreSQL, Tailwind v4, pnpm `11.4.0`, Node `>=22.14.0`. Một số phần mô tả trong README/master spec còn ghi Next `16.2.11`; **`package.json`/lockfile của commit triển khai** là nguồn xác minh phiên bản, không sao chép API từ trí nhớ. `AGENTS.md` yêu cầu đọc tài liệu Next trong `node_modules/next/dist/docs/` trước khi code.

### 3.1. Contract tương thích PR169

| Mảng thay đổi của PR169 | Contract đã đọc | Phần Upsell được phép làm |
| --- | --- | --- |
| `cart-promotion-model.ts`, `PromotionBanner` | Cart/drawer chỉ giữ progress gần nhất theo **tỷ lệ %**, checkout chỉ có `achieved` và không có next milestone. | **Giữ nguyên banner thông tin**; thêm đúng một `CheckoutUpsell` action riêng tại checkout. Không dùng `view().nearest` để chọn campaign. |
| `gift-quantity-quote.ts#orderValueProgress` | Trả next rung/shortfall cho `QUANTITY_TIER/ORDER_SUBTOTAL` tại **stage trước chính ladder**, kể cả khi ladder sau còn giảm giá dòng. Vẫn **display-only**, không ở signed proof. | Dùng để gợi ý việc enumerate rung, nhưng phải verify full hypothetical +1 per variant trên canonical quote/stack. |
| `gift-quantity-tier.ts`, `gift-quantity-stack.ts` | Order-value ladders chạy **sau legacy/quantity**, lần lượt theo `(priority, id)`. Reachability/conflict xét trên giá sau các bước trước; nếu campaign bị drop thì rerun fail-closed. | Tính `S_tier` tại đúng stage, không dùng final subtotal hoặc phỏng đoán từ price không có ladder. |
| `order-summary-model.ts`, `OrderSummary` | Savings rows tại PR169 HEAD mới reconcile với listed unit price; checkout kiểm **expected listed value** và **signed total**, mismatch => fallback. | Sau add đồng bộ display, không dùng saving row làm eligibility hay estimated incremental price. |
| `guest-shipping-policy.ts` + benefit checkout/proof | Shipping tính từ quote sau discount; tiền hàng tier chia thành price segments, snapshot/proof phải giữ đúng giá. | Tính `deltaPayableVnd` từ hai full canonical quotes (bao gồm shipping); sau commit bắt buộc có proof mới. |
| `getStorefrontCartView()` | Drawer đọc same server view as cart khi gift/tier gate ON; flag OFF bảo toàn old path. | Không fork một `cart view` riêng cho checkout Upsell; không cần thay drawer trong MVP. |

**Evidence refresh (PR169 `89428fd7`):** Đã so với `c6b11af` (+4 commits, 17 files): `priceStack/priceWithReachedLadders` đánh giá reachability nhiều order-value ladders theo thứ tự, `readOrderValueProgress` phục hồi stage trước ladder, `tierSavingRows` reconcile với listed price, checkout `buildOrderSummary` kiểm `expectedValueVnd`. Những read-model thay đổi này không thay thế +1 hypothetical authority. **Khi PR169 đổi HEAD phải re-review spec trước technical signoff**, sau merge verify trên merged SHA.

**Khác biệt có chủ đích:** PR169 có thể vẫn hiển thị *một progress banner ở cart/drawer* chọn theo % hoàn thành; SPEC-UPS-001 chỉ yêu cầu *một offer hành động ở checkout* chọn theo **chi phí tăng thêm thấp nhất**. Hai bề mặt có mục tiêu khác nhau, nên không ép dùng một ranking; nhưng **không được để checkout hiển thị hai lời mời mua thêm trái nhau**.

### 3.2. Dependency/gate trước implementation

1. **PR169 chưa merge:** spec đối chiếu `head@89428fd7…` nhưng các module này **chưa có trên `main`**. PR169 đổi HEAD ⇒ bắt buộc re-review diff/FR/AC **trước technical signoff** (không chỉ trước merge/build). `/plan` ghi dependency; sau merge lấy merged SHA để verify trước `/build`.
2. **PR169 có migration:** enum `FIXED_AMOUNT_TOTAL_VND` và `tierBasis`, ràng buộc scope/bounds. Migration này **thuộc PR169**, không tạo migration thứ hai cho Upsell nếu không có yêu cầu riêng; rollout phải bảo đảm deploy/migrate PR169 trước khi bật campaign order-value.
3. PR169 tự ghi nhận **chưa hoàn tất Playwright và chưa xác nhận POS end-to-end**, và có test fail được nêu trong PR. Đây là release gate còn mở, **không** được dùng mô tả PR làm bằng chứng production-ready.
4. **Không sửa PR169 trong spec này.** Nếu quá trình build phát hiện bug thật trong nguồn PR169, ghi finding/test và xử lý qua PR phù hợp thay vì ngầm nới lỏng ngữ nghĩa Upsell.

## 4. Quy tắc tính cơ hội

### FR-01 — Điều kiện bật và fail-closed

1. Flag server-only mới **đề xuất** `LA_PROMOTION_UPSELL_ENABLED=true`, mặc định OFF. Khi OFF, không thêm truy vấn/đánh giá/side effect Upsell; byte-for-byte giữ checkout/cart/PR169 view contract hiện có khi tương đương dữ liệu.
2. `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` vẫn phải ON, campaign ACTIVE và POS shop có capability phù hợp khi offer **sau khi thêm** làm đơn trở thành benefit order (đặc biệt `QUANTITY_TIER/ORDER_SUBTOTAL`). Không được dùng Upsell để vượt qua flag, proof, reservation hay POS gate chưa đạt.
3. Chỉ chạy với cart/checkout quote hợp lệ. Cart trống, line không khả dụng, selected gift sai, quote/proof unavailable hoặc post-add benefit checkout không có quyền tạo đơn => **không hiển thị offer**. Lỗi đọc recommendation không được làm hỏng một checkout khác đang hợp lệ. **Không có flag PR169 riêng:** `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` là flag của Gift & Quantity hiện có; `LA_PROMOTION_UPSELL_ENABLED` là flag Upsell mới dự kiến. Test trạng thái các flag này độc lập và kiểm tra POS capability riêng.
4. Chỉ xét campaign ACTIVE tại `now` của request: Draft, Scheduled chưa đến giờ, Ended, Disabled => không hứa quyền lợi. Xét revision/stacking theo server facts, không qua dữ liệu banner do browser gửi.

### FR-02 — Ngưỡng số lượng

1. Đếm `Q` bằng tổng số chiếc **PAID trong scope**; một set/composite được mua như một đơn vị = một chiếc, không đếm gift, không đếm số dòng/mẫu.
2. Với `GIFT_ITEM` có `giftTrigger=QUANTITY`, dùng `shortfallToNext.quantity` từ entitlement engine; với `QUANTITY_TIER` có `tierBasis=QUANTITY` (kể cả NULL legacy), dùng rung `QuantityTier.minQuantity` **tiếp theo chưa đạt**; không lấy ngưỡng từ banner.
3. Near iff `nextQuantity - Q === 1`. Biến thể được gợi ý phải là một dòng eligible thật, có thể thêm 1 READY unit, vượt rung đó và tăng quyền lợi có giá trị.
4. Không nhầm `QUANTITY_TIER/ORDER_SUBTOTAL` thành bậc số lượng dù DB vẫn đặt tên cột `minQuantity`. Không đề xuất khi gift cap/ONCE đã xong, campaign drop/stack conflict, hoặc rung mới không tạo lợi ích hợp lệ.

### FR-03 — Ngưỡng giá trị (bao gồm PR169)

1. Hỗ trợ **hai loại threshold tiền khác nhau**, tuyệt đối không dùng một `subtotal` chung:
   - `GIFT_ITEM` + `giftTrigger=ORDER_SUBTOTAL`: `S_gift` = tổng tiền **PAID sau tất cả discount/stacking có hiệu lực**, trước shipping, không gồm gift; áp dụng `ALL_PAID_LINES` hoặc `ELIGIBLE_PAID_LINES` theo gift scope. Lấy `shortfallToNext.subtotalVnd`/ngưỡng thực từ gift entitlement.
   - `QUANTITY_TIER` + `tierBasis=ORDER_SUBTOTAL` (PR169): `S_tier` = paid goods **ngay trước ladder đó**, sau legacy/quantity và **các order-value ladders trước nó theo (priority, id)**; không gồm gift/ship và không trừ discount của chính nó hoặc các ladder chạy sau. `QuantityTier.minQuantity` là VND, `scopeMode=GLOBAL_ALL_PAID_LINES`. Nhiều ladder phải re-evaluate reachability/stacking theo chuỗi thực; không lấy final subtotal của cả cart để đo tất cả.
2. Không lấy `OrderSummary.valueText`, `CartViewModel.subtotalText` hoặc giá catalog làm input cho eligibility. `orderValueProgress.currentVnd/next` của PR169 có thể giúp liệt kê rung cần xét **nhưng chỉ là hint display**; nếu thiếu/stale/conflict thì lấy chính pricing authority để đánh giá, không đoán.
3. Với **từng campaign** xác định `S`/`T` theo đúng basis và **ngưỡng thưởng tiếp theo**: gift ONCE đã nhận thì không có rung tiếp; gift REPEAT sử dụng bội số kế, tôn trọng cap; tier dùng rung kế chưa đạt, kể cả khi đã ở một rung thấp hơn.
4. Near iff `0 <= S < T` và `5*S >= 4*T`, so sánh VND bằng integer/`BigInt` (80% **bao gồm**). Đây là **80% của mốc T tuyệt đối**, KHÔNG phải `progress.percent` của banner PR169 tính tiến độ từ rung trước tới rung sau.
5. Ví dụ: `T=1.000.000`, `S=799.999` ẩn; `S=800.000` đủ near để tìm sản phẩm; `S=1.000.000` đã đạt nên không near **mốc này**. Tier có rung cũ 1.000.000, rung sau 2.000.000 và `S=1.700.000` vẫn near (85% rung kế), dù thanh PR169 hiển thị 70% tiến độ giữa hai rung.
6. Khi giả lập add +1 phải **chạy lại toàn bộ chain**: một chiếc niêm yết 150.000đ có thể không đủ vì legacy discount/quantity tier làm đổi `S` hay stacking drop; ngược lại order-value discount mới cũng không được làm sai `S_tier` bằng cách tự trừ chính nó.
7. Các cơ sở/đơn vị của PR169 là contract cần giữ: order-value `PERCENTAGE` tính per unit, `FIXED_AMOUNT_TOTAL_VND` chia vào paid segments có làm tròn xác định và không làm unit price dưới 1đ (`TIER_PRICE_INVALID` loại cả bước). Upsell **không được tái triển khai phép chia/rounding này**.

### FR-04 — Điều kiện “mua 1 là đạt” (bắt buộc)

1. Với **mỗi biến thể** gợi ý, server dựng **hypothetical cart read-only** = cart hiện tại + đúng `1 READY` unit thuộc **mẫu khác** (không ghi Cart/Order/GiftSelection, không giữ hàng, không phát quote proof). Đánh giá bằng **canonical cart/checkout pricing, stacking, gift entitlement** trên đầy đủ trước/sau; không đủ nếu chỉ cộng gap, xem banner hoặc áp dụng một công thức tại client.
2. Campaign đích hợp lệ khi **(a)** thật sự vượt rung chưa đạt **và (b)** sau re-evaluation có quyền lợi tăng: gift tăng entitlement có thể cấp (`grantable`) và còn lựa chọn quà thực sự, hoặc quantity/order-value tier có rung mới **áp dụng** với mức giảm **thực tế tạo thêm lợi ích** của campaign, không chỉ thay label/rung có cùng discount value.
3. Giữ nguyên contract PR169: stacking song phương, Flash Sale không mất ưu đãi, **order-value ladders chạy sau legacy/quantity theo (priority, id)** với stage-specific reachability/re-run nếu drop; fixed-total allocation đúng từng paid unit và `TIER_PRICE_INVALID` drop nguyên bước. `STACK_NOT_PERMITTED`, `STACK_PRIORITY_CONFLICT`, invalid price/scope hoặc ladder đích không còn reachable trong simulated final quote ⇒ loại candidate.
4. **Quà mới được hưởng nhưng chưa chọn không phải lỗi eligibility**: offer vẫn hợp lệ nếu có gift `grantable` và checkout có đường chọn quà/acknowledgement được duyệt (FR-09); không tự chọn quà. Chỉ loại candidate nếu quà **không thể cấp** theo stock/capacity, selection **đã lưu** trở nên không hợp lệ, POS shop chưa verify cho post-add benefit order, hoặc quote/shipping không thể xác minh. Không được đưa khách vào trạng thái mua thêm xong nhưng không thể đặt hàng.
5. **Bảo toàn quyền lợi hiện có (MVP, fail-closed):** so sánh ledger/entitlement trước và sau **theo campaign**, không chỉ so tổng tiền hoặc campaign đích. Loại candidate nếu bất kỳ discount/campaign vốn đang áp dụng bị drop, giảm số tiền lợi ích đã có, làm giá của paid units cũ tăng vì mất khuyến mãi, giảm `entitled`/`grantable` của quà đã hưởng, vô hiệu gift selection hiện tại, hoặc tạo `TIER_PRICE_INVALID`/stack conflict mới ảnh hưởng ưu đãi cũ. Một ưu đãi mục tiêu mới không được dùng để che khoản ưu đãi khác đã mất; **không** cố tính “bù trừ lợi ích” trong MVP. Quy tắc chỉ áp dụng chọn gợi ý, **không** cấm khách tự chỉnh giỏ hay đặt checkout bình thường.
6. Simulation chỉ là **advisory**. Mutation vẫn phải xác minh dưới cùng lock/revision/capacity authority và đối chiếu cùng ngữ nghĩa FR-04, **bao gồm bảo toàn quyền lợi cũ**; client token/preview không phải chứng cứ giá hay quyền lợi. Khi quyền lợi/gift availability đổi giữa preview và click, từ chối **trước commit**, không âm thầm áp dụng giỏ mới.
7. Nếu không thể đối chiếu từng campaign từ canonical ledger/quote một cách có cơ sở (thiếu steps/entitlement provenance hoặc shipping/price unavailable), **không đưa candidate đó vào Upsell**; không suy diễn bằng tổng tiết kiệm trình bày trong PR169 `OrderSummary`.

### FR-05 — Chọn duy nhất một campaign

1. Chỉ liệt kê cơ hội near thực sự có ít nhất một biến thể thỏa FR-04 trong cả bốn trường hợp D-01; với mỗi campaign tính chi phí mua thêm từ **canonical before/after full checkout quote** theo phương án U-01 **chưa duyệt**, không so gap VND, số lượng thiếu, giá card hoặc `% progress` PR169. Việc khóa thuật toán xếp hạng triển khai đợi owner chốt U-01.
2. Chọn campaign bằng **chi phí mua thêm thấp nhất trong tập biến thể đã được đánh giá và xác minh** (FR-06); tie-break xác định `campaignId` → `productId` → `variantId` tăng dần. Không khẳng định thấp nhất toàn catalog nếu truy vấn bị giới hạn. Khi một sản phẩm mở đồng thời hai ưu đãi, tính full quote có stacking thật, không cộng riêng hai lợi ích một cách suy đoán; offer vẫn gắn với một campaign thắng.
3. `PromotionBanner` của PR169 trên **cart/drawer** có thể chọn gần nhất theo progress%; Upsell **checkout** không dùng `view().nearest`. `buildCheckoutPromotionView` giữ nhiệm vụ hiển thị ưu đãi đã đạt; **không thêm một progress CTA thứ hai vào banner**.
4. Nếu không có campaign nào với biến thể khả thi, **ẩn Upsell**; luồng COD hiện tại vẫn dùng được.

### FR-06 — Danh sách 3–5 sản phẩm

1. Lấy từ catalog/scope campaign đang thắng, cùng Pancake shop; chỉ các `ProductMirror` present + active và có ít nhất một variant **READY có khả năng cấp hàng**, theo capacity/selling authority (bao gồm reservations và composite constraints). Không giới thiệu PREORDER/OVERSELL như “còn hàng”.
2. Loại trừ mọi `productId` đã tồn tại trong cart paid lines, kể cả một mẫu khác màu/size; một mẫu hiển thị tối đa một card.
3. Mỗi card phải có ít nhất một **biến thể khả dụng mà thêm đúng một chiếc làm đạt ưu đãi**. Khi người mua đổi color/size/kind, chỉ bật CTA cho biến thể đã đạt kiểm tra này; ở thời điểm click server bắt buộc kiểm tra lại.
4. Sắp xếp theo **chi phí tăng thêm tăng dần từ full quote** (FR-07), tie-break `productId`/`variantId`. Hiển thị tối đa 5 mẫu; nếu chỉ có 1–2 mẫu hợp lệ, hiển thị đúng 1–2, **không bù bằng sản phẩm sai điều kiện**. Với `ORDER_SUBTOTAL`, card rẻ nhất theo giá niêm yết chưa chắc là card đạt bậc hoặc ít tốn tiền nhất sau fixed-total/percentage discount.
5. **Bounded ranking contract U-03:** catalog/scope/stock/capacity cần query có giới hạn, sort ổn định, có index/batching, không N+1. Với `ORDER_SUBTOTAL` global của PR169, **không** được coi `ORDER BY giá niêm yết LIMIT 5` là chứng cứ tìm được chi phí tăng thêm tốt nhất; mô phỏng có thể làm đổi tier/ship/stacking. Chạy full quote cho từng biến thể trong **tập ứng viên đã lấy**, xếp hạng deterministic rồi chọn tối đa 5 mẫu. Giới hạn số candidate, thời gian/DB query budget phải được chọn và benchmark ở `/plan` (chưa có ngưỡng số do owner duyệt).
6. Nếu bị truncate/budget hết, có thể hiện **các mẫu thực sự vượt qua FR-04 trong tập đã xác minh** và dùng copy trung tính “Gợi ý thêm để đạt ưu đãi”; **không** nói “rẻ nhất toàn cửa hàng”. Nếu không xác minh được candidate nào thì ẩn module, không thay bằng gợi ý chưa mô phỏng. Ghi telemetry sampled `candidate_pool_truncated`, số candidate đã đánh giá, nhưng không có dữ liệu khách/secret. **Không** coi kết quả catalog search là entitlement authority.
7. Ưu tiên hiện 3–5 sản phẩm; **1–2 sản phẩm là fallback hợp lệ** nếu tập đã xác minh chỉ có vậy. Nếu không có sản phẩm hợp lệ thì ẩn Upsell (D-08); không nhân bản card/variant để đủ số.
8. **Per-variant price:** Mỗi option được kiểm phải có `currentUnitPriceVnd` và `estimatedIncrementalCostVnd` dựa trên **hypothetical quote của chính `variantId` đó** theo U-01 đã duyệt; nếu chưa có số phù hợp phải re-quote read-only trước khi bật CTA. Thay kind/màu/size phải đổi đúng giá/estimate/token; stale quote/token ⇒ xóa estimate cũ, không giữ minimum của sản phẩm để làm giá của option mới.

### FR-07 — “Chi phí mua thêm” và cách hiển thị (**U-01: đề xuất, chờ owner xác nhận**)

- **Phương án A, đề xuất nhưng chưa được duyệt:** `deltaPayableVnd = quoteAfter.totalVnd - quoteBefore.totalVnd`, từ pricing/fulfillment/shipping authority cho **cùng địa chỉ/chính sách ship tại thời điểm hiển thị** (after = hypothetical, chưa signed; quote ký cuối chỉ cấp sau commit). Nếu địa chỉ chưa đầy đủ để tính phí ship, **không** được tự giả định phí 0đ hoặc tùy tiện thay đổi basis; cần thiết kế fallback được owner duyệt trước triển khai. Campaign eligibility luôn dựa trên `Q`/`S_gift`/`S_tier`, **không** dùng total gồm ship. **Phương án B chưa duyệt:** chỉ dùng giá thực trả của đúng chiếc mới, không đưa thay đổi ship/benefit toàn giỏ vào thứ tự ranking.
- PR169 có `OrderSummary` chỉ để trình bày bill, kiểm `expectedTotalVnd` và (HEAD mới) `expectedValueVnd` của listed-price lines. Ranking phải lấy canonical before/after quote, không dùng presentation saving; account for `FIXED_AMOUNT_TOTAL_VND`, thứ tự Flash Sale/tier và shipping.
- Nếu `deltaPayableVnd` là 0 hoặc âm khi unlock promotion, hiển thị minh bạch “Dự kiến tổng thanh toán thay đổi…”/“Dự kiến tiết kiệm…” kèm tổng mới; không khẳng định món mới miễn phí hay giá chắc chắn được bảo đảm. Nếu delta dương, không đồng nhất `delta` với **giá lẻ** sản phẩm. Tất cả candidate vẫn phải giữ nguyên quyền lợi cũ theo FR-04.
- Card có tên, trusted image, **current unit price của biến thể được chọn** và **incremental cost estimate của đúng biến thể** (hai số có thể khác). Chưa chọn option thì chỉ hiển thị minimum dạng **'Từ …'** trong eligible pool, không gọi đó là giá variant được chọn; nếu estimate <=0 diễn đạt thay đổi tổng dự kiến thay vì 'món miễn phí'. Chuyển option phải cập nhật price/estimate và signed token cùng snapshot hoặc re-quote trên server; cấm hiển thị giá cũ của size khác. Tổng chốt chỉ từ fresh checkout quote/proof, không từ preview. Phương pháp tính estimate chờ owner U-01.
- **Hard gate U-01:** Trước `/plan`/`/build`, owner xác nhận A hay B và hành vi khi chưa biết shipping. Khi chưa được xác nhận, AC-09/AC-40/AC-44 kiểm tra phương án A **ở mức đề xuất**, không có quyền dùng làm acceptance release gate. Sau xác nhận, cập nhật ranking/copy/test; không được tự ngầm chọn một cách tính.

### FR-08 — Inline add trên checkout; **offer token theo ngữ cảnh**

1. Khách chọn kind/color/size và **“Thêm vào giỏ để nhận ưu đãi”** trong checkout; thêm **đúng 1 chiếc**. Không yêu cầu mở PDP/cart cho happy path; không tạo checkout form thứ hai và không tự chọn quà.
2. Token cho **từng variant đã verify** là **HMAC-signed với payload đọc được** (KHÔNG encrypted, KHÔNG thực sự opaque), domain-separated key, canonical bounded payload và TTL. Chỉ serialize **strict allowlist** `PublicUpsellOfferPayload` ở **mục 6**: token version, server-derived non-secret cart/quote hashes, monotonic write-version tag **không chứa cart UUID**, shop, campaign kind/basis/id/revision, exact target, variant và timestamps. **`cartId` lấy từ HttpOnly `la_cart` cookie tuyệt đối không có trong base64url payload/token bytes, DOM, URL, logs hoặc analytics**: nó chỉ là **MAC context từ server**, length-framed như `computeMac` trong `checkout-quote-proof.ts`. HMAC bảo đảm authenticity/integrity và bind với cart, **không giấu** nội dung payload; muốn ẩn payload phải dùng AEAD hoặc server-side random handle (không chọn cho MVP). U-05 về version/ABA độc lập với ràng buộc bảo mật này.
3. Public Server Action chỉ nhận `{ offerToken, productSlug, variantId }` (hoặc ít hơn nếu đã bind trong signed payload), không nhận cart ID/giá/subtotal/threshold/discount/quantity từ client. Verify HMAC bằng `cartId` đọc từ cookie server, rồi re-evaluate mọi payload field với current canonical quote/campaign/variant. Không deserialize signed payload thành pricing authority; signed offer token **không** là session auth hay COD quote-proof. Validate shape/size trước I/O, failed verification không leak internal/session ID.
4. Trong **cùng transaction, dưới cart lock**, đọc đúng shop/cart/paid lines/campaign revision và current canonical quote; xác minh token chưa hết hạn, snapshot/quote/mốc/campaign/biến thể vẫn khớp, sau đó re-evaluate chính **mốc đã hiển thị** và FR-03/04/benefit-preservation + READY capacity. Mọi điều kiện fail => typed `STALE_OFFER`/`CART_CHANGED` **trước khi ghi**. Không dùng `addStorefrontItemToBag()` như một write độc lập rồi mới kiểm campaign; phải bổ sung seam conditional read+add quanh existing `addItemUnit` semantics. Nếu implementation không có write-version/nonce để giải quyết ABA, phải ghi tradeoff và review trước `/build` thay vì suy đoán từ `updatedAt`.
5. Accepted = commit đúng **1 paid unit**, không tạo Order/Pancake. Double-click / cùng token ở hai tab được serialize; token cũ không thể commit thêm sau khi giỏ đã đổi. Nếu response thành công bị mất, **không tự retry mutation**; refresh quote/cart để khách biết kết quả. Emit `add_to_cart`/Meta đúng một lần từ committed facts; không phát từ giá render.
6. Trong cùng tab, vô hiệu add/submit trong lúc mutation + refresh; checkout re-render `PromotionBanner` (achieved), PR169 `OrderSummary`, **signed checkout quote-proof mới**, và gift state hiện tại. Giữ tên/SĐT/địa chỉ người nhận; không submit proof cũ. Reset acknowledgement theo **quote digest mới** (không mang tick qua giữa hai quote).
7. Race hai tab/submit đồng thời phải fail closed nhờ server serialization, fresh quote-proof và capacity gate; pending UI **không** thay thế concurrency authority. Error/stale hiển thị nguyên nhân tổng quát, không leak campaign internals, không tự retry add.

**Offer wire/MAC invariant:** `token = base64url(canonical(PublicUpsellOfferPayload)) + '.' + base64url(HMAC(upsellDomainKey, lengthFramed(cartIdFromHttpOnlyCookie, payloadBytes)))`. Chỉ `PublicUpsellOfferPayload` nằm trên wire; cookie UUID **chỉ dùng bên trong HMAC input**, không phải payload, URL hoặc server action argument. HMAC key tách domain với COD quote proof; verifier phải đọc HttpOnly cookie hiện tại rồi verify token và current facts trước transaction add. Đây là design contract; U-05 cần chốt source write-version/replay/ABA trước build.

### FR-09 — Quà vừa mở khóa (**U-02: UX chờ owner xác nhận**)

- PR169 checkout banner (`buildCheckoutPromotionView`) hiện chỉ phản ánh **quà đã nằm trong signed quote**, không cung cấp gift picker inline; trang `/cart` có `BrandCartGiftPicker`. Vì vậy **banner PR169 không thay thế** bước chọn quà sau khi Upsell làm phát sinh `earned/entitled` mới.
- **Phương án A (đề xuất, chưa owner duyệt):** để khách chọn quà ngay trong checkout sau Upsell bằng gift-picker presentation seam + existing server gift selection service; validate lại entitlement/stock và tạo quote-proof mới sau chọn. Không auto-choose gift, không đổi quà cũ im lặng. **Phương án B (cần owner duyệt riêng):** dẫn tới `/cart` để chọn quà rồi trở lại checkout; có nguy cơ không thỏa kỳ vọng D-03 và phải đảm bảo bảo toàn thông tin checkout.
- Quote mới có unclaimed slot phải hiển thị minh bạch và xử lý `nonclaimAcknowledged` theo quote digest hiện tại; tick/ack của quote cũ không được mang sang, kể cả khi chỉ thêm một chiếc.
- **Hard gate U-02:** Trước `/plan`/`/build`, owner chốt A/B. Không ship lời mời “mua thêm để nhận quà” mà thiếu luồng thật để khách chọn quà khi offer mở ra slot mới. Không tự cắt `GIFT_ITEM` khỏi scope đã duyệt để lách checkpoint.

### FR-10 — Bỏ qua và tái hiển thị

1. CTA phụ **“Không mua thêm, tiếp tục thanh toán”** ẩn module Upsell ngay, không đổi giỏ, giá, proof hoặc form.
2. Lưu lựa chọn ẩn ở **tab/checkout session**, keyed bằng fingerprint an toàn của **danh sách variant+quantity PAID**, **không** keyed bằng quote digest (vì giá/campaign đổi không đồng nghĩa giỏ đổi). Đề xuất `sessionStorage` chỉ cho trạng thái trình bày, không lưu cart ID, proof, PII.
3. Reload, PR169 `OrderSummary` refresh, giá/ship/promotion re-quote hoặc banner cập nhật **khi paid cart không đổi** đều không tự bật Upsell lại; thêm/xóa/đổi số lượng paid line làm fingerprint đổi thì được đánh giá lại. Không ép từ chối nhiều lần một offer trong cùng lượt thanh toán.
4. Đóng module không phải xác nhận từ chối quà đã được hưởng; phân biệt hoàn toàn `dismissUpsell` với `nonclaimAcknowledged`.

### FR-11 — Trạng thái và lỗi

- `hidden` (gate OFF/không near/no eligible), `ready`, `variant-unselected`, `adding`, `refreshing-quote`, `stale`, `unavailable`, `error`; trạng thái `achieved/progress` của PR169 là **presentation khác**, không phải máy trạng thái Upsell. `STALE_OFFER` là lời mời/mốc đã thay đổi hoặc token hết hiệu lực; không được diễn giải là giỏ đã commit.
- Stale campaign/stock/quote → copy nhẹ “Ưu đãi hoặc tình trạng sản phẩm đã thay đổi. Giỏ hàng chưa được thêm sản phẩm. Vui lòng xem gợi ý mới.”
- Nếu đọc gợi ý lỗi/timeout, **ẩn Upsell nhưng không chặn checkout đang hợp lệ**; nếu chính quote/order authority lỗi, checkout theo cơ chế fail-closed vốn có.
- Error/retry không được tự click mua lại; retry mới là hành động chủ động của khách.

### FR-12 — UI và accessibility

- Một module `CheckoutUpsell` **riêng** nằm trong luồng đọc checkout **ngay trước thông tin nhận hàng**, nhưng **không** tạo form thứ hai. PR169 đã render `PromotionBanner` ở trên grid checkout và `OrderSummary` trên mobile/desktop theo viewport; không nhân đôi hai vùng này hay phá cấu trúc sticky summary. Có **một** bộ điều khiển Upsell/state/mutation duy nhất trong accessibility tree.
- Hiển thị tên/rule campaign, progress `2/3` hoặc `900.000/1.000.000`, gap và 3–5 card cùng hai hành động add/skip. Với order-value tier hiển thị số tiền **tại stage mà campaign xét**, không nhầm với tiền thanh toán cuối. Không hiển thị hai câu “mua thêm…” cạnh nhau từ PR169 banner và Upsell; không hứa quà khi gift stock không cấp được.
- Cho xem chi tiết sản phẩm nếu muốn, nhưng happy path **không** bắt buộc rời checkout. Image/price/availability đúng catalog; demo trước đây chỉ là **mockup**, không phải nguồn thông tin sản phẩm hoặc chính sách bán hàng. Lựa chọn dùng **dimension có kiểu** (`kindKey`, `color`, `size`, `variantId`) và reuse selector logic hiện có; không parse `label` để suy ra biến thể. Biến thể hết hàng/không unlock không có active offer token, không được click thêm với lời hứa promotion.
- Dùng native buttons, accessible labels, trạng thái `role=status`/`aria-live=polite`, focus hợp lý khi thêm/skip/campaign mất hiệu lực; keyboard, screen reader, touch 44px, contrast, mobile 320/390, 768, desktop 1280/1440.
- Mỗi nút add nằm trong form có `type="button"`; không được kích hoạt submit COD ngoài ý muốn.

## 5. Quy trình server-authoritative (đề xuất)

```text
Checkout request (main + PR169 merged, existing signed quote flow)
  -> current anonymous paid cart + canonical checkout quote/proof
  -> check LA_PROMOTION_UPSELL_ENABLED AND LA_GIFT_QUANTITY_PROMOTIONS_ENABLED
  -> opportunity read (new; failure independent from valid COD checkout)
     -> active GIFT_ITEM + QUANTITY_TIER (basis QUANTITY | ORDER_SUBTOTAL)
     -> optional PR169 orderValueProgress for candidate rung hints ONLY
     -> near filter (units: gap==1; money: 80% absolute next threshold)
     -> bounded catalog/scope/READY capacity candidate lookup; exclude cart productIds
     -> for each eligible variant simulate paid cart +1 (no write/no reserve/no proof)
        -> existing legacy + quantity + order-value pricing chain + gift entitlements
        -> evaluate post-add POS/stock/selection/signed-quote feasibility
        -> compare before/after actual benefit; reject dropped/invalid/conflicting
     -> rank verified hypothetical cost within bounded evaluated pool (U-01/U-03); 1 winning campaign, <=5 product cards
  -> render existing PR169 achieved PromotionBanner + separate CheckoutUpsell
     -> reuse PR169 OrderSummary / total display, never as price authority

Buyer selects option (typed kind/color/size) -> show matching variant price/estimate -> click Add with HMAC-signed (readable) variant-specific offer token
  -> bounded input -> verify signed payload with cookie cart ID used only as MAC context
  -> cart lock -> verify cart/version + current quote + exact rung + campaign revision + variant
  -> re-evaluate new benefit AND preserve existing benefits; reject stale before write
  -> exactly +1 paid unit committed OR typed no-write refusal
  -> refresh checkout quote/proof and PR169 summary/banner; preserve input fields
  -> newly earned gift selection / nonclaim acknowledgement follows existing contract
  -> existing COD submit -> fresh quote-proven order snapshot/reservation/Pancake
```

**Invariant A:** Upsell/PR169 banner là presentation; **server pricing + signed checkout/order authority** duy nhất quyết định discount, quà, stock và giá chốt.

**Invariant B:** Read-only simulator và mutation phải dùng **cùng** scope + tier basis + stacking + price allocation/rounding + gift entitlement. Không tự tái triển khai `floor(Q/N)`, `N0`, order-total discount allocation, shipping hoặc percentage rounding trong UI.

**Invariant C:** PR169 `orderValueProgress` và `PromotionBanner.progress.percent` **không phải chứng cứ đủ** cho “mua 1 nhận ưu đãi”. Offer phải có variant cụ thể và full post-add quote chứng minh entitlement hoặc giảm giá tăng.

**Invariant D:** PR169 `OrderSummary`/named discount rows **không thuộc proof authority**; checkout quote-proof mới sau add vẫn bind tất cả lines/role/quantity/unit prices/segments. Mismatch phải fail closed thay vì hiện số khác nhau.

**Invariant E:** Race add vs submit: server serialization/quote proof reject stale; UI pending chỉ hỗ trợ UX. Không bao giờ gửi đơn với quote cũ sau khi paid cart biến động.

**Invariant F:** Một candidate chỉ được chọn nếu mốc **cụ thể được quảng bá** mở khóa đúng quyền lợi, mọi ưu đãi **đang hưởng trước đó** được giữ nguyên, và offer token ràng buộc đúng cart/quote/campaign revision/variant/rung trước khi commit. `campaignId` không đủ làm authorization token.

**Invariant G:** “Rẻ nhất” được hiểu **trong tập ứng viên đã đánh giá**, không đưa tuyên bố tối ưu toàn catalog khi bị truncate. U-01/U-02 là điều kiện owner signoff trước khi implement, không phải mặc định đã được duyệt.

## 6. Data contract dự kiến (chưa implement)

```ts
/** `QUANTITY_TIER` uses basis, `GIFT_ITEM` uses trigger. Never mix them. */
export type PromotionUpsellCampaign =
  | Readonly<{ id: string; kind: "GIFT_ITEM"; trigger: "QUANTITY" | "ORDER_SUBTOTAL"; title: string }>
  | Readonly<{ id: string; kind: "QUANTITY_TIER"; basis: "QUANTITY" | "ORDER_SUBTOTAL"; title: string }>;

/** Monetary progress is at the campaign's own pricing stage, not the final payable total. */
export type UpsellThreshold =
  | Readonly<{ unit: "PAID_UNIT"; current: number; next: number; remaining: 1 }>
  | Readonly<{ unit: "VND"; currentVnd: number; nextVnd: number; remainingVnd: number }>;

export type PromotionUpsellView = Readonly<{
  campaign: PromotionUpsellCampaign;
  threshold: UpsellThreshold;
  /** Chosen by owner U-01 before build; all estimates/ranking use the same approved basis. */
  costBasis: "TOTAL_PAYABLE_DELTA" | "ADDED_UNIT_EFFECTIVE_PRICE";
  /** UI dismissal only; NOT a server authorization condition. */
  cartFingerprint: string;
  /** Partial catalog evaluation is never claimed to cover the whole shop. */
  candidateSearchTruncated: boolean;
  products: readonly Readonly<{
    slug: string; // public presentation key; actual ProductMirror.id stays server-owned
    name: string;
    image: { url: string; alt: string } | null; // trusted media only
    minEstimatedIncrementalCostVnd: number; // minimum across VERIFIED options only; 'Từ …' before selecting a variant
    options: readonly Readonly<{
      variantId: string;
      kindKey: string | null;
      kindLabel: string | null;
      color: string | null;
      size: string | null;
      label: string; // display only, never parsed as option authority
      currentUnitPriceVnd: number; // listed server price of THIS variant; informational, not final COD price
      originalUnitPriceVnd?: number; // optional catalog markdown, if real
      estimatedIncrementalCostVnd: number; // hypothetical quote for THIS variant, in costBasis; may be <=0
      estimatedTotalAfterVnd: number | null; // available only if chosen U-01 basis can quote total/ship
      available: boolean;
      achievesThreshold: boolean;
      /** Issued only for server-verified eligible variant, scoped to exact offer context. */
      offerToken: string | null;
    }>[];
  }>[];
}>;

/** Only safe client-provided input; no cart id, money, promotion terms or quantity. */
export type AddUpsellInput = Readonly<{
  offerToken: string;
  productSlug: string;
  variantId: string;
}>;

/** Only these NON-SECRET fields may be serialized in the signed, readable token payload. */
export type PublicUpsellOfferPayload = Readonly<{
  tokenVersion: 1;
  paidCartSnapshotHash: string; // non-secret digest, NOT raw cart contents or cart UUID
  cartWriteVersion: string; // non-secret monotonic tag; NOT Cart.id/cookie UUID
  canonicalQuoteHash: string; // non-secret digest; NOT quote/proof/prices
  shopId: number;
  campaignId: string;
  campaignRevision: number;
  campaignKind: "GIFT_ITEM" | "QUANTITY_TIER";
  campaignRuleBasis: "QUANTITY" | "ORDER_SUBTOTAL"; // trigger for gift, tierBasis for tier
  target: UpsellThreshold;
  variantId: string;
  issuedAt: number;
  expiresAt: number;
}>;

/** Server-only MAC context. NEVER serialize this object into a public token. */
export type ServerOfferMacContext = Readonly<{
  cartIdFromHttpOnlyCookie: string; // secret session handle used ONLY as length-framed MAC input
  payload: PublicUpsellOfferPayload; // ONLY this member is on the wire
}>;

export type AddUpsellResult =
  | Readonly<{ ok: true; addedQuantity: 1 }>
  | Readonly<{
      ok: false;
      reason:
        | "FEATURE_DISABLED"
        | "CART_CHANGED"
        | "STALE_OFFER"
        | "VARIANT_UNAVAILABLE"
        | "BENEFITS_UNAVAILABLE"
        | "LIMIT_EXCEEDED"
        | "TRY_AGAIN";
    }>;
```

**Contract notes:** proposed contract, không có Upsell source trên `main`. Null `tierBasis` của PR169 là `QUANTITY`. `offerToken` là **signed-readable payload**, không encrypted/opaque; người dùng có thể decode `PublicUpsellOfferPayload`, nhưng bytes không được chứa `cartId`/cookie UUID/PII/secret/price authority. `ServerOfferMacContext.cartIdFromHttpOnlyCookie` chỉ lấy từ cookie server và đưa vào MAC input theo length framing; token cart X phải fail với cookie cart Y. Sau HMAC verify vẫn phải đối chiếu mọi trường với canonical current facts, giữ COD quote-proof độc lập. `cartWriteVersion` là U-05 chưa được xác minh về ABA. Mỗi variant estimate lấy từ cùng hypothetical quote của token chính variant đó; U-01 còn chờ quyết định cách tính. Validate/limit input và tuyệt đối không leak cart ID/quote proof/PII/secret trong log/errors/analytics.

## 7. Ownership dự kiến, không phát sinh subsystem trùng

| Owner | Chức năng dự kiến |
| --- | --- |
| `src/commerce/promotion-upsell-policy.ts` *(new)* | Pure near filter cho `GIFT_ITEM/trigger` và `QUANTITY_TIER/basis`, winner ranking, deterministic tie-break, safe-money comparisons; **không dùng** PR169 `nearest` để chọn offer. |
| `src/commerce/promotion-upsell-service.ts` *(new)* | Gated read-only opportunity; bounded search + full hypothetical canonical quote/entitlement/stacking (bao gồm PR169 order-value tier); optional hint từ `orderValueProgress`. |
| `src/commerce/promotion-upsell-actions.ts` *(new)* | Boundary cho strict public signed-readable token, `cartIdFromHttpOnlyCookie` chỉ là server-only HMAC context; verify cart/quote/campaign/rung/variant/write-version và transactional conditional +1; COD signed proof độc lập. |
| `src/routes/checkout.ts` + `checkout-model.ts` | Extend optional checkout Upsell model **trên contract PR169**; giữ nguyên achieved `PromotionBanner` và signed benefit quote, không đưa `progress` mới vào builder PR169. |
| `src/components/brand/checkout-upsell.tsx` *(new)* | Một module UI duy nhất: typed `kindKey/color/size`, per-variant unit price/estimate gắn với own offer token, add/skip/pending; không dùng minimum product làm selected option price. |
| `src/components/commerce/guest-checkout-form.tsx` và brand adapter | Một seam cho Upsell trong **cùng một form**, preserve field state, phối hợp pending with checkout submit. |
| PR169 `cart-promotion-model.ts`, `promotion-banner.tsx`, `order-summary-model.ts`, `order-summary.tsx`, `getStorefrontCartView()` | **Reuse presentation** trong cart/drawer/checkout; không dùng các view models để authorize tiền/offer. |
| Existing `gift-quantity-*`, `checkout-quote-*`, `storefront-cart-*`, `storefront-actions.ts` | **Reuse business authority** qua typed seams; không fork PR169 order-value allocation, không phá proof/stacking/stock; nếu cần extract pure hypothetical evaluator, characterization tests trước. |
| `tests/domain`, `tests/database`, `tests/a11y-runtime` | Tests theo ownership; không thêm dependency nếu không cần. |

**Schema/dependency:** Upsell **không dự kiến có migration riêng** (không tạo campaign/discount table, dismissal chỉ client UI). Hai migration order-value (`20261015100000…`, `20261015100100…`) **đã nằm trong PR169** và là dependency nếu dùng order-value tier; không nhân bản trong Upsell. **Chưa xác minh** cart monotonic write-version qua mọi child mutation: nếu không có nguồn version tin cậy và cần bổ sung persistent nonce/version, phải nêu scope migration + ADR/owner approval (U-05) thay vì tuyên bố no-migration chắc chắn.

## 8. Test matrix / acceptance criteria

| ID | Dữ liệu / hành động | Kỳ vọng |
| --- | --- | --- |
| AC-01 | Gift QUANTITY N=3, cart Q=2, có eligible khác mẫu còn READY | 1 offer, add 1 đạt >=1 suất quà mới. |
| AC-02 | N=3, Q=1 | Không near; hidden. |
| AC-03 | Gift T=1.000.000đ; S=799.999/800.000/999.999/1.000.000đ | Biên 80% chính xác; chỉ 800.000 và 999.999 là near cho **mốc này**. |
| AC-04 | S=900.000, candidate +80.000 / +150.000 | +80.000 bị loại, +150.000 chỉ được hiện nếu **re-quote** đạt mốc. |
| AC-05 | Candidate có giá trên nhãn đủ nhưng sau stack reprice chưa tới T | Bị loại; không copy hứa tặng. |
| AC-06 | `REPEAT_PER_THRESHOLD` / gift capped / ONCE đã hưởng | Chỉ xét mốc **có thể hưởng thêm**; capped/ONCE không gợi ý. |
| AC-07 | Tier Q=3, next tier N=4, tăng mức discount hợp lệ | Add 1 mở tier mới; giá từng chiếc/segments từ canonical resolver. |
| AC-08 | Tier next level cùng discount value, `TIER_PRICE_INVALID`, stacking conflict | Không quảng cáo quyền lợi mới/không khả thi. |
| AC-09 | 2 campaign near (gift vs PR169 order-value tier), best incremental payable 90.000 vs 110.000đ | Với **phương án A chưa duyệt ở U-01**, offer campaign 90.000đ theo full before/after checkout quote. Tie deterministic; không dựa vào `% progress`. |
| AC-10 | 6 sản phẩm candidate (2 cùng mẫu khác biến thể), một đã nằm trong giỏ | Tối đa 5 **mẫu khác nhau**, không trùng bất kỳ productId đã mua; đúng count theo số mẫu eligible trong pool. |
| AC-11 | Chỉ còn 1–2 mẫu hợp lệ / không còn mẫu | Hiện 1–2 / ẩn; không fill bằng lựa chọn không đạt điều kiện. |
| AC-12 | Gift stock hết, gift selected của cart mất hiệu lực, POS chưa được verify | Không chào quyền lợi không thể thực hiện; checkout theo gate hiện hành. |
| AC-13 | Chọn color/size có offer; đổi sang variant không đạt mốc | CTA đúng trạng thái, server không chấp nhận add với hứa hẹn sai. |
| AC-14 | Successful add ở checkout | Exactly +1 unit; quote/proof/total mới; không đổi tên/phone/address; không gửi Pancake; không add-to-cart event trùng. |
| AC-15 | Double click, hai tab, submit đồng thời, campaign/stock/revision đổi trong lúc add | Token gắn đúng một snapshot + rung + variant; add thắng commit đúng +1, token cũ bị stale trước write, submit với proof cũ bị từ chối; không bán/snapshot báo giá cũ. |
| AC-16 | Dismiss + reload/quote refresh không đổi giỏ | Không re-show; submit COD vẫn hoạt động. |
| AC-17 | Dismiss + add/remove/update paid line | Có thể xét cơ hội mới; gift skip acknowledgement là trạng thái riêng. |
| AC-18 | Quote sau add tạo entitlement mới, còn `unclaimed` nhưng gift READY vẫn `grantable` | **Không lọc bỏ offer chỉ vì quà chưa chọn**; khách thấy quyền lợi và picker/ack theo phương án U-02 **được owner chọn**; proof cũ không hợp lệ. |
| AC-19 | **Ma trận 2 flag có thật/dự kiến:** Upsell OFF/Gift ON; Upsell ON/Gift OFF; cả hai OFF; cả hai ON + POS chưa/chưa verify | Không có flag độc lập của PR169; Upsell chỉ hoạt động khi cả `LA_PROMOTION_UPSELL_ENABLED` và `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` ON **và** hậu điều kiện POS/canonical quote hợp lệ. OFF không thêm side effect, banner/checkout hiện có giữ nguyên. |
| AC-20 | Read suggestion lỗi hoặc quá budget | Upsell ẩn; không tự làm hỏng checkout vốn đang hợp lệ. |
| AC-21 | 320/390/mobile, 768/tablet, 1280+/desktop, keyboard/screen reader | Focus, nhãn màu/size, thông báo động, 1 form, submit có `type` đúng, không layout overflow. |
| AC-22 | Giá, ảnh, tồn kho, địa chỉ/Pancake checkout thực tế | Không dùng fake brand/policy/product/stock; auth proof + immutable quote + stock held đúng existing flow. |
| AC-23 | PR169 `QUANTITY_TIER/ORDER_SUBTOTAL` T=1.000.000, S=900.000; candidate hợp lệ +120.000 | Hiển thị một offer; +1 chuyển rung, áp dụng percentage hoặc fixed-total như canonical engine, không dùng gift trigger. |
| AC-24 | PR169 order-value tier T=1.000.000, S=799.999/800.000/1.000.000 | Biên 80% đúng: 799.999 ẩn; 800.000 có thể xét; đúng T thì đã đạt rung này, xét rung tiếp nếu có. |
| AC-25 | Tier rung trước 1.000.000 → rung sau 2.000.000, S=1.700.000; PR169 bar hiển thị 70% | Upsell xét **85% của mốc 2.000.000**, được tìm candidate; không dùng PR169 `progress.percent` để ẩn sai. |
| AC-26 | Legacy Flash Sale + quantity ladder đang giảm giá; PR169 order-value tier global chạy cuối | `S_tier` lấy **trước own order-value discount, sau các bước trước**; mô phỏng +1 không làm mất Flash Sale do stacking; nếu conflict/drop => không offer. |
| AC-27 | PR169 `FIXED_AMOUNT_TOTAL_VND` rung đạt sau add; discount phải chia per unit, sinh nhiều paid segments | Đúng tổng giảm, unit price >=1đ, signed quote/proof và immutable snapshot parity; không tự chia discount tại Upsell. |
| AC-28 | PR169 cart/drawer banner có near gift A (% lớn nhất), còn winner theo chi phí U-01 của checkout là tier B | Cart/drawer giữ banner informational; checkout chỉ có một action offer B + existing achieved banner, không có hai lời mời mua thêm mâu thuẫn. |
| AC-29 | `orderValueProgress` tồn tại, nhưng candidate cụ thể +1 không đủ ngưỡng, tier bị drop hoặc POS không chấp nhận post-add benefit | Ẩn candidate/campaign; không coi progress hay forced-stacking probe như bằng chứng mua 1 đạt. |
| AC-30 | `OrderSummary` PR169 refresh sau successful add; giá phân bổ/ship thay đổi; form đã nhập và quote-proof cũ | Mới đúng tất cả lines/discount/ship/total, proof cũ bị từ chối; preserve form; không double-count savings và không trả tổng không khớp. |
| AC-31 | Dismiss offer, paid cart không đổi nhưng PR169 `OrderSummary`/shipping/campaign display re-quote | Không bật Upsell lại; chỉ paid-cart fingerprint đổi mới cho xem lại. |
| AC-32 | Token được phát cho campaign A mốc N=3, trước khi click campaign lên revision mới hoặc target đổi sang N=4 | Không chấp nhận add theo mốc khác; trả `STALE_OFFER` **không ghi** và request refresh. |
| AC-33 | Hai tab cùng snapshot, tab 1 mua biến thể A, tab 2 dùng token cũ mua biến thể B | Tab 2 bị từ chối theo snapshot/quote mismatch trước commit; tổng chỉ có đúng hành động A. |
| AC-34 | Double submit cùng token hoặc A→B→A restore paid cart trong hạn token (ABA) | Replay không tạo +2 ngoài ý muốn; chứng minh nguồn write-version/nonce tăng qua child writes hoặc ghi rõ blocker U-05, không chỉ dựa `Cart.updatedAt`. |
| AC-35 | Token có signed `variantId=A` nhưng request dùng B; hoặc attacker sửa campaign/rung/expiry | Verify signature/binding thất bại; không add, không leak cart id/secret/nội dung token. |
| AC-36 | Candidate mở gift mới nhưng làm mất quantity tier/Flash Sale đang áp dụng, giảm `grantable` quà cũ hoặc làm selected gift invalid | **Loại candidate** dù campaign mục tiêu tăng entitlement hoặc total payable có thể giảm; checkout bình thường không bị can thiệp. |
| AC-37 | Catalog có >budget candidate cho global order-value tier; giá card niêm yết rẻ nhất chưa chắc delta payable thấp nhất | Xếp deterministic theo full quote **trong tập đã xác minh**, log truncation; UI không claim tối ưu toàn catalog; không thêm candidate chưa kiểm. |
| AC-38 | Một mẫu có `kindKey` (full set/áo lẻ), nhiều màu/size; label giống nhưng variant ID khác; một size hết hàng | UI chọn typed kind/color/size, token per verified variant; không suy variant bằng label; CTA biến thể không eligible bị tắt. |
| AC-39 | Upsell mở suất quà mới và khách muốn chọn quà tại checkout | **Nếu U-02 chọn phương án A:** gift selection inline, refresh proof sau chọn, không điều hướng/không mất form. **Nếu chọn B:** test flow cart→checkout và bảo toàn form riêng; không tự chọn quà. |
| AC-40 | Với proposal U-01 A, 2 candidate có giá món khác nhau, discount/ship thay đổi, delta payable có thể âm/0 | Rank bằng **total delta** từ cùng quote/shipping basis, label không gọi là giá món miễn phí; nếu shipping chưa xác định, block ranking theo A cho đến khi chốt fallback. Nếu chọn B, thay test trước build. |
| AC-41 | PR169 `GIFT_ITEM/ORDER_SUBTOTAL` và `QUANTITY_TIER/ORDER_SUBTOTAL` đồng thời near; selected gift không hợp lệ hoặc campaign mới conflict | Phân biệt `S_gift`/`S_tier`, preserve lợi ích cũ; không chọn offer chỉ theo `orderValueProgress`/banner. |
| AC-42 | Decode base64url payload của HMAC signed offer, biết trước cookie `la_cart`/`Cart.id` | Bytes payload/token, DOM, response/log/analytics không có **raw cart UUID**; strict public allowlist; HMAC không phải encryption. |
| AC-43 | Offer token ký cho cart X, server đọc cookie cart Y; payload bị sửa/expired | MAC sai theo cart context => reject trước write, không đọc/chuyển giỏ của X, không leak UUID. |
| AC-44 | Cùng mẫu size S giá 150.000đ, L giá 250.000đ, mỗi variant có verified hypothetical cost khác nhau; đổi S→L | Selected price + `estimatedIncrementalCostVnd` + token đổi theo **L**, không tiếp tục hiện product minimum/giá của S; trước khi chọn chỉ copy **'Từ …'** hoặc ẩn estimate; test theo lựa chọn U-01 sau owner signoff. |
| AC-45 | PR169 `89428fd7`: hai order-value ladders A/B active, A chạy trước làm subtotal dưới ngưỡng B; stack/drop re-run | `S_tier` tính tại stage của B; B không được quảng bá sai, hypothetical +1 phải dùng `priceStack` đầy đủ và preserve benefits. |
| AC-46 | PR169 `89428fd7`: tier chạy trước Flash Sale, ledger tier saving khác listed-price delta | PR169 cart/checkout saving rows và `OrderSummary.expectedValueVnd` reconcile chính xác; Upsell không lấy presentation saving làm variant cost authority. |

## 9. Verification commands và chiến lược

Đọc `package.json`, lockfile, `AGENTS.md`, test config trên **commit thực thi** rồi dùng script repo, không đoán version/API. Các lệnh dự kiến:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
```

**Regression PR169 phải giữ (HEAD `89428fd7`):** `tests/domain/cart-promotion-model.test.ts`, `tests/domain/order-summary-model.test.ts`, `tests/domain/gift-quantity-order-subtotal-tier.test.ts`, `tests/domain/gift-quantity-tier-basis.test.ts`, `tests/database/gift-quantity-order-value.test.ts`, `tests/database/gift-quantity-order-value-checkout.test.ts` cùng regression cũ. Thêm regression order→order reachability, stage-aware progress, listed-price savings, selected variant estimate, token decode không leak UUID và cross-cart replay. PR169 đổi HEAD phải re-review trước signoff; build verify trên merged SHA.

**Browser:** tại `tests/a11y-runtime/` dùng Playwright (`@playwright/test`), thêm `checkout-upsell.spec.ts` vào `testMatch` nếu cần; kiểm tra mobile 390, desktop 1280, keyboard, form-state. Assert `PromotionBanner` chỉ hiện earned states trên checkout và `CheckoutUpsell` là action riêng, không duplicate CTA. Test Postgres mutation/requote/race và PR169 order-value price segments/proof. `pnpm release:check`/Pancake POS cần môi trường, credentials được phê duyệt; không đưa key vào log.

**TDD:** (1) RED tier basis/near/rank + multiple order-value reachability; (2) GREEN full hypothetical + preserve campaign entitlements; (3) security token payload decode/cross-cart MAC tests và database conditional add/replay/ABA; (4) UI selected variant unit-price/estimated cost/token sync, quote proof & PR169 savings/OrderSummary, gift picker theo U-02; (5) Playwright/a11y; (6) flags/POS + regression. Không suy giá từ browser/banner.

**Tình trạng kiểm chứng tài liệu v1.3:** đã đọc PR170 review và đối chiếu `main` với PR169 `89428fd7` (+4 commits từ `c6b11af`) ở core stack/progress/savings/checkout, cùng `checkout-quote-proof.ts` và `anonymous-cart-cookie.ts`. Static review/spec diff; **không chạy** repo tests/build/DB/browser/POS ở tác vụ docs-only này.

## 10. Security, hiệu năng, telemetry, rollout

- **Security:** Client input untrusted, server validates IDs/lengths/relations. Offer token ký HMAC **không mã hóa**, chỉ serialize strict `PublicUpsellOfferPayload`, không bao giờ cookie/cart UUID/PII/secret/price authority. `cartIdFromHttpOnlyCookie` là MAC context length-framed từ server như checkout quote-proof; distinct key domain, TTL; tampering, token X on cookie Y => fail before write; U-05 xử lý replay/ABA + cart lock. Token không thay anonymous-cart auth/COD proof; không log/display cart UUID, full offer token, secret hoặc buyer PII.
- **Performance:** một opportunity read tối đa 1 lần/checkout load; global order-value tiers PR169 có thể tăng candidate pool nên phải batched/indexed/bounded, deterministic, no N+1 và có cơ chế tắt/timeout module Upsell **không ảnh hưởng checkout**. Không tìm cách tối ưu toàn catalog theo giá niêm yết khi delta payable là non-monotonic; báo “rẻ nhất trong pool đã xác minh”, ghi truncation. Đo p95 checkout, DB query count, candidate truncation/near false negatives trên catalog thực; chưa tự đặt lời hứa “nhanh” khi chưa benchmark.
- **Analytics:** `upsell_impression`, `upsell_select_variant`, `upsell_add_attempt`, `upsell_add_accepted`, `upsell_dismiss`, `upsell_stale` là proposal. Campaign kind/id + banded amounts hợp lệ, không PII; existing `add_to_cart` dùng committed snapshot như PDP, tránh đếm hai lần và không tự tạo Meta/browser event từ giá render.
- **Telemetry:** error rate của eval/action, latency p95, candidate counts/truncation, offer→add ratio, quote-invalid/retry; high-cardinality request IDs chỉ trong structured trace/log nội bộ, không dùng làm metric labels.
- **Rollout:** **PR169 merge + verified migrations/release gates** là dependency cho order-value Upsell. Flag `LA_PROMOTION_UPSELL_ENABLED` mặc định OFF; staging bật đúng Gift/Quantity gate + POS verified shop, pilot một campaign, xác nhận cả gift/tier số lượng và PR169 order-value percentage/fixed-total, gift claims, tier split, mobile/keyboard/direct checkout. Rollback chỉ Upsell bằng flag OFF; không auto rollback PR169 hoặc tự bật promotion gate. Không live probe/deploy trong `/spec`.

## 11. Code style và boundaries

Phù hợp convention TypeScript ESM `import type`, `Readonly`, discriminated unions, pure policy tách khỏi I/O:

```ts
export type NearThreshold =
  | Readonly<{ kind: "QUANTITY"; remainingUnits: 1 }>
  | Readonly<{ kind: "ORDER_SUBTOTAL"; currentVnd: bigint; nextVnd: bigint }>;

export function isNearMoneyThreshold(currentVnd: bigint, nextVnd: bigint): boolean {
  return currentVnd >= 0n && nextVnd > 0n && currentVnd < nextVnd && 5n * currentVnd >= 4n * nextVnd;
}
```

**Always:** có test cho mỗi rule; reuse canonical quote; xác thực lại trong transaction; không hứa reward khi POS/stock không khả thi; source-driven docs theo Next version; theo WCAG baseline.

**Ask first:** thay schema, thêm dependency, sửa payment/quote-proof/stock policy, thay threshold, tự chọn quà, cho phép PREORDER/OVERSELL, bật flag production hoặc điều chỉnh POS contract.

**Never:** dùng giá client để tính đơn; tự viết engine giảm giá song song; bỏ check quote-proof; im lặng sửa hoặc xoá gift selection; làm checkout không đặt được chỉ do recommendation lỗi; gắn secret vào logs; thay đổi ngoài scope.

## 12. Definition of Done (gate khi triển khai, không phải đã hoàn thành)

- AC-01…AC-46 phải có test RED/GREEN, integration và E2E; **AC-09/AC-39/AC-40/AC-44 phụ thuộc owner U-01/U-02**; PR169 cases verify trên merged SHA.
- Flag OFF bảo toàn contract/cart/checkout byte-for-byte khi có thể kiểm thử; không gây thêm side effect.
- Lint/typecheck/domain/integration/database/build/browser-a11y + live conditional POS gates (nếu có) được chạy thực tế và ghi kết quả.
- Route/quote/variant/basis/price/security/race, gift preservation và token freshness/ABA được review; không có drift giữa hypothetical, PR169 order-value stack và committed quote; docs ADR D-11…D-13/Gift&Quantity spec được đồng bộ theo merged SHA trước ship.
- Có dashboard/rollout monitoring, rollback khả dụng, operator approval và không có blocker chưa được chủ cửa hàng chấp thuận.

## 13. Các quyết định và checkpoint trước `/plan` hoặc `/build`

| ID | Chủ sở hữu | Quyết định / bằng chứng cần cung cấp | Gate |
| --- | --- | --- | --- |
| **U-01** | **Owner** | Chốt cost basis A (đề xuất) = `totalPayableAfter - totalPayableBefore` gồm discounts/shipping, hoặc B = giá thực trả chiếc mới, và fallback khi thiếu shipping. Rank và **per-variant estimate/label `costBasis`** phải nhất quán; card chưa chọn chỉ 'Từ …' hoặc ẩn estimate, chọn S/L phải cập nhật theo variant/token. Đồng bộ FR-05/06/07, AC-09/28/40/44 sau owner quyết định. | **Block `/plan`/`/build` pricing/ranking** |
| **U-02** | **Owner** | Chốt quà sau Upsell: **A (đề xuất)** chọn quà ngay checkout bằng service hiện có; hoặc **B** qua cart và quay lại checkout có bảo toàn dữ liệu. Không tự chọn quà; cập nhật FR-09 và AC-18/39. | **Block `/plan`/`/build` gift UX** |
| **U-03** | Kỹ thuật / reviewer | Thiết kế bounded candidate enumeration/query, index và measure; xác minh pool truncation, deterministic rank theo **full quote**; copy UI không claim cheapest toàn catalog. | Phải có bằng chứng trước build |
| **U-04** | Owner khi scope thay đổi | Free-shipping threshold/legacy PROMOTION/FLASH_SALE/CLEARANCE không có mốc riêng trong v1; chúng vẫn tác động price. Không tự mở thêm loại khuyến mãi ngoài D-01. | Scope guard |
| **U-05** | Kỹ thuật / security reviewer | Duyệt strict `PublicUpsellOfferPayload` signed-readable vs `ServerOfferMacContext` (cookie UUID MAC context only, never wire), domain key separation, cross-cart rejection, TTL. Chốt nguồn monotonic cart write-version/nonce qua child writes hoặc giải pháp tương đương; transactional re-eval + add, replay/ABA tests. Không coi token HMAC là encrypted hoặc session auth; schema nếu cần phải xin owner/ADR. | **Block `/build` mutation** |

**G-01 (dependency, không phải câu hỏi mới):** PR169 phải được review/merge+migrate/verify trên merged SHA trước `/build` order-value Upsell. **Nếu HEAD khác `89428fd7`, bắt buộc re-review diff và AC-23…29/41/45/46 trước technical signoff**; không chờ tới merge. PR170 docs-only target `main` khi PR169 còn open.

**Tình trạng P1 self-review:** P1 token/context đã có contract testable ở FR-08/AC-32…35/AC-42…43 nhưng chưa implement; P1 ranking đã phân biệt bound và **đang chờ U-01**; P1 gift picker đã có hai flow đề xuất và **đang chờ U-02**; P1 bảo toàn lợi ích đã được chốt thành fail-closed invariant trong FR-04/AC-36. Không tuyên bố self-review findings đều “closed” khi owner gate chưa được duyệt.

## 14. Repository references

**Main baseline (`4c46488b…`)**

- [La.na master spec](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/4c46488b180acd44481858a8a32f9e848368df24/docs/specs/la-na-design-master-spec.md)
- [Gift & Quantity spec](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/4c46488b180acd44481858a8a32f9e848368df24/docs/specs/gift-quantity-promotions-v1.md)
- [Gift entitlement engine](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/4c46488b180acd44481858a8a32f9e848368df24/src/commerce/gift-quantity-entitlement.ts)
- [Checkout form](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/4c46488b180acd44481858a8a32f9e848368df24/src/components/commerce/guest-checkout-form.tsx)
- [POS evidence](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/4c46488b180acd44481858a8a32f9e848368df24/docs/integrations/pancake-gift-quantity-acceptance.md)

**PR169 re-reviewed HEAD (`89428fd7…`, PR vẫn open; snapshot `c6b11af` đã cũ)**

- [PR169 — source, discussion, checks](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/169)
- [Stack ordered order-to-order reachability](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/commerce/gift-quantity-stack.ts)
- [Stage-aware progress](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/commerce/gift-quantity-quote.ts)
- [New order-to-order regressions](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/tests/domain/gift-quantity-order-subtotal-tier.test.ts)
- [PR169 savings reconciliation regressions](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/tests/domain/cart-promotion-model.test.ts)
- [ADR 0016 D-11…D-13](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/docs/decisions/0016-gift-quantity-promotions-v1-decisions.md)
- [Tier basis và order subtotal pricing](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/commerce/gift-quantity-tier.ts)
- [Order-value progress/read model](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/commerce/gift-quantity-quote.ts)
- [Cart banner logic and ranking](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/routes/cart-promotion-model.ts)
- [Checkout model, only achieved promo banner](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/routes/checkout-model.ts)
- [PR169 checkout render](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/app/checkout/page.tsx)
- [PR169 order summary](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/src/routes/order-summary-model.ts)
- [PR169 order-value checkout DB test](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/89428fd7ca7543a6dc4c34715dcf80f2a9584fd8/tests/database/gift-quantity-order-value-checkout.test.ts)


---

**Handoff v1.3:** PR170 docs-only, owner U-01/U-02 và technical U-03/U-05 vẫn mở; các review comments đã xử lý **trong spec, chưa implement**. Mọi PR169 HEAD sau `89428fd7` phải re-review trước technical signoff → PR169 merged & verified → `/plan` → `/build` test-first → `/review` → `/ship`. Không bật flag/migrate/deploy qua PR này.
