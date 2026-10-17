# SPEC-UPS-001 — Smart Promotion Upsell (MVP)

**Trạng thái:** DRAFT v1.6 (15/10/2026). **Owner đã duyệt U-01/A (tính chênh lệch tổng thanh toán, phí ship cơ bản mặc định 30.000đ) và U-02/A (chọn quà ngay checkout)**. U-03/U-05 còn chờ kiểm tra kỹ thuật trong `/plan`; **chưa triển khai Upsell**.  
**Nguồn đã merge:** `main@6ba8e2d209f6298ed1ebcb7f84a73acefa7d7f5a` (PR #169, order-value tiers + cart/checkout promotion). Source đã merge **không đồng nghĩa** production DB đã migrate hoặc Pancake POS đã được nghiệm thu.  
**Phạm vi:** tài liệu nghiệp vụ cho Upsell; ghi nhận quyết định owner, không thay code, schema, feature flag hay deploy.

> **Amendment AM-01 (17/10/2026) — owner chọn phương án A ở OD-01 của [UX-COMMERCE-001](storefront-promotion-upsell-checkout-ux-v1.md).** Phần trình bày ở checkout **thay** D-03, D-04 (phần hiển thị), FR-06 (phần UI), FR-07, FR-08 (phần thao tác tại checkout), FR-09 (hành trình unlock) và FR-12 theo §8 bên dưới. D-01/02/05/06/07/08, U-01/A, FR-01…FR-05, FR-10, FR-11 và mọi authority server (quote, proof, stock, stacking) **giữ nguyên**. Các mục bị thay vẫn để nguyên văn bên dưới làm lịch sử; khi đọc, §8 thắng.

**Mục tiêu:** Khách gần đạt mốc ưu đãi thấy **một** lời mời mua thêm hợp lệ ở checkout, chọn mẫu/size/màu và thêm **đúng một chiếc** mà không mất dữ liệu nhận hàng hoặc quyền lợi hiện có. Nếu không có gợi ý an toàn, checkout vẫn hoạt động như cũ.

## 1. Yêu cầu nghiệp vụ đã duyệt (giữ nguyên D-01…D-08)

| ID | Quy tắc |
| --- | --- |
| D-01 | Xét cả bốn loại: `GIFT_ITEM/QUANTITY`, `GIFT_ITEM/ORDER_SUBTOTAL`, `QUANTITY_TIER/QUANTITY` và `QUANTITY_TIER/ORDER_SUBTOTAL` (PR169). |
| D-02 | Mốc số lượng phải thiếu **đúng 1 chiếc**; mốc tiền phải đạt **từ 80% đến dưới 100%** của mốc tiếp theo. |
| D-03 | Chọn phân loại/màu/size và thêm 1 chiếc **trực tiếp tại checkout**; giá/ưu đãi tự làm mới. |
| D-04 | Hiện tối đa 3–5 **mẫu** hợp lệ, còn hàng; nếu chỉ có 1–2 mẫu thì hiện đúng số đó. |
| D-05 | Nhiều campaign gần mốc thì chỉ hiện **một cơ hội** có chi phí mua thêm thấp nhất theo quy tắc U-01 được duyệt. |
| D-06 | Bỏ qua thì ẩn trong lượt checkout; chỉ đánh giá lại sau khi giỏ trả tiền thay đổi hoặc bắt đầu lượt mới. |
| D-07 | Không gợi ý mẫu đã có trong giỏ, dù khác màu/size (so `ProductMirror.id`). |
| D-08 | Chỉ gợi ý biến thể được server xác nhận rằng **thêm đúng 1 chiếc** sẽ mở được ưu đãi ngay; nếu không có thì ẩn. |

**Ngoài scope MVP:** không Upsell riêng cho Flash Sale/Clearance/khuyến mãi per-variant hoặc mốc freeship; các chương trình này vẫn ảnh hưởng giá. Không thêm campaign admin mới, không tự viết engine giá thứ hai, không tự chọn quà, không đổi chính sách PREORDER/OVERSELL.

## 2. Hành vi cần xây (FR-01…FR-12)

### FR-01 — Điều kiện hiển thị
- Upsell có flag server `LA_PROMOTION_UPSELL_ENABLED` **mặc định OFF**, hoạt động chỉ khi `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` cũng ON, campaign ACTIVE, cart/quote hợp lệ và shop đáp ứng gate POS áp dụng cho đơn sau add.
- Flag OFF/không có ứng viên/lỗi tính gợi ý ⇒ không thêm side effect, không làm hỏng checkout hiện hành; lỗi của **chính** checkout quote vẫn fail-closed như cũ.

### FR-02 — Mốc số lượng
- `Q` đếm số chiếc PAID trong scope (không đếm quà; composite mua như một đơn vị). Dùng entitlement hiện có cho gift, rung **tiếp theo chưa đạt** cho quantity tier (tierBasis NULL nghĩa QUANTITY).
- Chỉ near khi `nextQuantity - Q === 1`; gift ONCE đã hưởng, REPEAT đạt cap hoặc rung không tăng lợi ích thì không gợi ý.

### FR-03 — Mốc tiền
- `GIFT_ITEM/ORDER_SUBTOTAL`: xét `S_gift` = tiền PAID **sau** discount/stacking, trước ship, theo scope gift.
- `QUANTITY_TIER/ORDER_SUBTOTAL`: xét `S_tier` **ngay trước chính order ladder** (sau legacy/quantity và những order ladder trước, theo priority/id), không dùng final payable hay banner progress. Merged PR169 chịu trách nhiệm rerun khi campaign bị drop.
- Near khi `0 ≤ S < T` và `5*S ≥ 4*T` (BigInt, so với **mốc tuyệt đối tiếp theo**). Giá trị mốc lấy từ engine; không tự tính bằng nhãn hiển thị. Gift trigger và tier basis là hai field khác nhau.

### FR-04 — Mỗi gợi ý phải mở quyền lợi thật
- Với từng biến thể READY của mẫu khác giỏ, **mô phỏng read-only cart +1**, chạy **chính** canonical pricing/stacking/entitlement/checkout quote của merged main, không ghi giỏ, giữ hàng, phát COD proof hoặc dùng giá browser.
- Chỉ chấp nhận khi rung quảng bá được áp dụng và gift `grantable` thực sự tăng / tier giảm giá thực có lợi. **So lợi ích trước–sau theo từng campaign**: không làm mất Flash Sale, tier, gift `entitled/grantable` hay vô hiệu gift selection đã lưu. Conflict, `TIER_PRICE_INVALID`, hết READY stock/POS capability hoặc quote không chứng minh được ⇒ bỏ ứng viên.
- Gift mới chưa chọn vẫn hợp lệ khi có lối chọn quà/xác nhận không nhận quà theo **U-02/A đã duyệt: chọn ngay ở checkout**. Bảo toàn quyền lợi chỉ ràng buộc *gợi ý*, không cấm khách tự chỉnh giỏ bình thường.

### FR-05 — Chọn campaign
- Chọn đúng một campaign có **chi phí thấp nhất trong tập ứng viên đã kiểm chứng**, tie-break cố định `campaignId → productId → variantId`. **U-01/A đã duyệt:** chi phí = `totalPayableAfter - totalPayableBefore` từ hai quote server cùng chính sách ship hiện hành; không xếp theo % progress hoặc giá niêm yết.
- `PromotionBanner` của PR169 vẫn hiển thị ưu đãi đã đạt, không được tạo CTA Upsell thứ hai.

### FR-06 — Chọn sản phẩm
- Chỉ lấy sản phẩm active/present cùng shop, có biến thể READY/capacity hợp lệ, không trùng `ProductMirror.id` đang mua. Bounded catalog query rồi chạy full hypothetical quote cho ứng viên trong pool; tối đa **5 mẫu khác nhau**.
- Nếu pool bị cắt, chỉ nói “Gợi ý thêm để đạt ưu đãi”, **không** tuyên bố “rẻ nhất toàn cửa hàng”; 1–2 mẫu là hợp lệ, 0 mẫu thì ẩn. Giới hạn query/time cụ thể chọn theo dữ liệu thật trong U-03, không đoán trước.

### FR-07 — Giá và lựa chọn biến thể
- Card hiển thị tên/ảnh đáng tin; mỗi `variantId` có giá hiện tại và **ước tính chi phí tăng thêm của chính biến thể đó** từ quote giả lập. Chọn lại kind/màu/size phải cập nhật giá, estimate và lựa chọn add tương ứng; biến thể không đủ điều kiện ⇒ không có CTA add hợp lệ.
- Chưa chọn variant chỉ hiển thị giá **“Từ …”** hoặc không hiện estimate. Estimate có thể bằng 0/âm khi toàn giỏ đổi ưu đãi; **không gọi món miễn phí**. Tổng tiền chốt chỉ từ quote/proof sau commit. **Shipping U-01/A:** dùng `calculateGuestShippingFeeVnd` cho cả quote trước/sau. Chính sách mặc định của checkout là **30.000đ khi không đủ điều kiện miễn ship** (miễn ship với đơn trên 1.000.000đ hoặc từ 3 sản phẩm); nếu cấu hình shop thay đổi thì dùng chính sách hiện hành từ server, **không cộng cứng 30.000đ**. Việc tính ship hiện không cần địa chỉ; nếu policy/quote không hợp lệ thì ẩn gợi ý thay vì đoán.

### FR-08 — Thêm 1 chiếc an toàn
- Public action chỉ nhận **biến thể được chọn** và bằng chứng ngữ cảnh giỏ/quote cần thiết; campaign/rung nếu client gửi chỉ là ý định, **không phải authority**. Không nhận tiền hoặc raw cart ID từ browser. **Ưu tiên kiểm tra xem COD checkout quote-proof HMAC hiện có có tái sử dụng được không**; chỉ tạo signed offer token riêng nếu U-05 chứng minh proof hiện tại không đủ ràng buộc thao tác.
- Trong **cùng transaction/cart lock**, đối chiếu bằng chứng với current cart/quote, campaign/rung, READY stock và chạy lại FR-04, rồi commit **đúng +1** hoặc từ chối **trước khi ghi**. Double-click/hai tab/replay/A→B→A không được ghi sai; U-05 phải chốt guard snapshot/write-version hoặc cách tương đương dựa trên source hiện có, **không** mặc định tạo nonce table/migration.
- Nếu cần token mới: HMAC signed ngắn hạn, public payload chỉ chứa field không nhạy cảm; cookie HttpOnly `la_cart` UUID chỉ dùng làm **MAC context phía server**, không nằm trong token/HTML/URL/log/analytics. HMAC không mã hóa và token không thay session auth hoặc COD proof.
- Sau commit: refresh checkout quote/proof/summary/gift, giữ tên/SĐT/địa chỉ, khóa submit trong lúc add/refresh, reset acknowledgement theo quote mới; không tạo đơn/Pancake ở thao tác add, không phát event add-to-cart trùng, không auto-retry khi kết quả không rõ.

### FR-09 — Quà vừa được mở
- Không tự chọn quà. Nếu Upsell mở gift mới thì cho khách thấy quyền lợi, chọn hoặc xác nhận không nhận quà theo **flow U-02 owner duyệt**; luôn refresh proof sau đổi gift selection.
- **U-02/A đã duyệt:** khi Upsell làm phát sinh suất quà mới, hiển thị picker **ngay tại checkout**, dùng lại gift selection authority hiện có, không điều hướng về cart và không mất form. **Nếu giỏ đã đạt mốc tặng quà trước checkout, khách vẫn chọn quà ở `/cart` như hiện tại.** Không tạo picker thứ hai nếu không cần; không ship gift Upsell khi luồng chọn quà tại checkout chưa hoạt động.

### FR-10 — Bỏ qua
- “Không mua thêm, tiếp tục thanh toán” chỉ ẩn module, không đổi giỏ/proof hay `nonclaimAcknowledged`. Một bản ghi **UI-only theo lượt checkout** trong tab có thể giữ qua reload/quote-only refresh để không hiện lại.
- Xóa trạng thái bỏ qua khi **paid lines thay đổi (kể cả A→B→A)**, bắt đầu checkout mới, cart mới/hết hạn hoặc đặt hàng xong. Tận dụng **cùng cart write-version** của FR-08 khi cần bắt thay đổi giữa các tab; không xây riêng DB/nonce cho dismissal. Không dùng raw cart UUID/PII; trước khi xác định trạng thái trên client không flash card đã đóng.
- Kỹ thuật phân biệt reload và lượt checkout mới được chốt/test tại U-05; UI state không bao giờ là quyền thêm hàng.

### FR-11 — Lỗi
- Không đủ hàng, stale campaign/cart/quote, timeout hoặc giá không đối soát được ⇒ ẩn offer hoặc thông báo cần refresh; **không tự thêm lại**. Recommendation failure không ngăn COD checkout vốn đang hợp lệ.

### FR-12 — UI/accessibility
- Một `CheckoutUpsell` gần phần thông tin giao hàng, nằm trong luồng checkout/form hiện có, **không form thứ hai**, không nhân đôi banner/summary; nút add là `type="button"`.
- Có nhãn kind/màu/size, trạng thái loading/error được thông báo, keyboard/focus đúng, mobile 320/390 và desktop; giữ nguyên form đã nhập khi add/skip/requote.

## 3. Giải pháp tối thiểu (không khóa kiến trúc sớm)

Chỉ cần ba trách nhiệm; tách thành file/module **khi code thực tế cần**, không bắt buộc tạo nhiều lớp pass-through:

1. **Đọc gợi ý (read-only):** lấy cart/campaign/candidate bounded, dùng chung PR169 `gift-quantity-*`, entitlement, checkout price/proof để mô phỏng +1, lọc rồi chọn một campaign + tối đa 5 mẫu.
2. **Action thêm 1:** reuse anonymous-cart/session/lock/stock/quote authority. Verify current quote/intent và điều kiện trong một transaction, không gọi hành động add độc lập rồi kiểm tra ưu đãi sau.
3. **UI checkout:** một widget variant picker, add/skip, refresh signed quote và giữ form. Reuse `PromotionBanner`, `OrderSummary` và gift selection service; không fork pricing/discount/shipping.

**Nguyên tắc:** Không thêm thư viện, bảng campaign, pricing engine, hàng đợi hay tầng API mới nếu hợp đồng hiện tại đủ dùng. Không mặc định cần migration Upsell; U-05 kiểm tra version/cart writes trước, nếu thiếu mới trình bày **thay đổi nhỏ nhất** để owner duyệt. Chỉ giới hạn candidate/timeout, log lỗi/tỷ lệ add/độ trễ cơ bản; benchmark/tuning chi tiết khi có dữ liệu thay vì đặt dashboard/phần trăm p95 từ đầu.

## 4. Nghiệm thu: 12 nhóm test, không phải 50 test độc lập

Các ID `AC-01…AC-50` từ [spec v1.4 trước khi rút gọn](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/blob/3369944118fa8a19a1924bce26d28fae60f103c4/docs/specs/smart-promotion-upsell-v1.md#L349-L402) được **gom nhóm để giữ truy vết**, không tự động đòi mỗi AC có một unit test + DB test + E2E riêng. Mỗi nhóm cần ít test nhất chứng minh được hành vi (unit cho quy tắc thuần, DB/integration cho mutation/quote, E2E cho checkout UX).

| Nhóm | AC cũ bao phủ | Hành vi phải chứng minh |
| --- | --- | --- |
| TG-01 — Flags/failure | AC-12, AC-19, AC-20, AC-22 | Gate OFF hoặc stock/POS/quote không đủ ⇒ không offer; checkout hiện có không bị hỏng. |
| TG-02 — Quantity | AC-01, AC-02, AC-06, AC-07, AC-08 | Thiếu đúng một chiếc, rung kế có lợi, gift caps/ONCE và tier invalid. |
| TG-03 — Money | AC-03, AC-04, AC-05, AC-23, AC-24, AC-25 | Biên 80%, hai monetary basis, rung tiếp và simulated +1 thực đạt. |
| TG-04 — Stacking | AC-26, AC-27, AC-29, AC-36, AC-41, AC-45, AC-46 | Order ladder stage, fixed-total segments, Flash Sale, conflict/drop; bảo toàn từng benefit và tiền/proof. |
| TG-05 — Winner/ranking | AC-09, AC-28, AC-37, AC-40 | Một winner, rank theo U-01/A bằng chênh tổng thanh toán gồm ship theo policy hiện hành trong bounded verified pool; không claim rẻ nhất toàn catalog. |
| TG-06 — Catalog | AC-10, AC-11, AC-38 | Không trùng mẫu; tối đa 5, fallback 1–2, exclude hết hàng; kind/màu/size typed. |
| TG-07 — Variant price | AC-13, AC-44 | Đổi size ⇒ đúng price/estimate và lựa chọn add; variant không đủ ngưỡng bị khóa. |
| TG-08 — Checkout add | AC-14, AC-30 | Commit +1; totals/proof/gift refresh; form giữ nguyên, không đếm event hai lần. |
| TG-09 — Quote/races | AC-15, AC-32, AC-33, AC-34, AC-35, AC-42, AC-43 | Proof/guard gắn đúng cart và quote; variant/rung được server kiểm lại; không lộ cart UUID; stale, double click/two tab/ABA không ghi sai. Nếu phát token mới, kiểm HMAC/cross-cart/tampering. |
| TG-10 — Gifts | AC-18, AC-39 | Gift đã đạt trước checkout chọn ở cart; gift mới nhờ Upsell chọn ngay checkout (U-02/A); ack/proof mới, không tự chọn. |
| TG-11 — Dismissal | AC-16, AC-17, AC-31, AC-47, AC-48, AC-49, AC-50 | Cùng lượt reload/requote vẫn ẩn; paid mutation/new cart/new lượt reset; không flash khi hydration. |
| TG-12 — Accessibility | AC-21 | Một form/CTA, keyboard/screen reader, thông báo trạng thái, mobile không tràn. |

**Regression tối thiểu:** giữ tests PR169 về order-value tiers/stacking, quote proof, order-summary và gift selection. Khi implement, viết unit tests cho threshold/ranking, integration/DB cho +1/quote/rollback/replay, vài Playwright scenarios cho add, dismiss và lỗi; không nhân 50 AC thành 50 bộ E2E. Test fixture và commands lấy từ `package.json`, `AGENTS.md` trên commit build, không đoán API Next.js.

## 5. Quyết định owner đã duyệt và kiểm tra kỹ thuật còn mở

| ID | Người chốt | Quyết định nhỏ nhất cần có |
| --- | --- | --- |
| U-01 | **Owner — ĐÃ DUYỆT A** | Tính bằng **tổng phải trả sau − tổng phải trả trước**, gồm giảm giá và phí ship. Phí ship cơ bản mặc định **30.000đ** theo `guest-shipping-policy.ts`; giữ nguyên miễn ship, cấu hình server và cùng chính sách checkout trên cả hai quote. Không cần chờ địa chỉ để lấy 30.000đ vì chính sách hiện tại không phụ thuộc địa chỉ; nếu chính sách không đọc được thì không tự đoán. |
| U-02 | **Owner — ĐÃ DUYỆT A** | Nếu Upsell mở suất quà mới, **chọn quà ngay tại checkout** mà không mất dữ liệu form. Quà đã đạt từ trước vẫn chọn ở `/cart` qua picker hiện có. Không tự chọn quà thay khách. |
| U-03 | **Kỹ thuật ở /plan** | Chọn bounded candidate pool/budget phù hợp catalog thật, deterministic rank trên pool đã mô phỏng; không benchmark/thiết kế index lớn khi chưa đo. |
| U-05 | **Kỹ thuật + security ở /plan** | Kiểm tra cart lock, **quote-proof HMAC hiện có**, stale/replay/ABA và version/guard phù hợp. Chỉ tạo offer token riêng hoặc thêm DB revision khi có trường hợp thực tế mà cơ chế hiện có không chặn được; nếu có token, cart UUID chỉ làm MAC context. Dismissal là UI state, không tự tạo version riêng. |

**G-01:** PR169 **đã merge** vào Git `main@6ba8e2d`; SQL migrations nằm trong repo. **Chưa có bằng chứng ở đây** rằng migrations đã chạy trên production DB, Pancake đã xác nhận line-level pricing, hoặc checkout Upsell đã chạy E2E. Đây là **release gates**, không phải lý do mở thêm subsystem trong spec.

## 6. Chất lượng, rollout và handoff

- **Trước build:** U-01/A và U-02/A đã được owner chốt; kỹ thuật giải quyết U-03/U-05 trong `/plan` từ merged main, đọc `AGENTS.md` + tài liệu Next theo version thật. Không đổi các quyết định đã duyệt bằng giả định.
- **Trước merge code:** chạy thực tế lint, typecheck, tests cần thiết và build theo scripts repo; DB integration cho race/proof; Playwright các luồng checkout quan trọng; giữ PR169 regression. Ghi kết quả, không coi docs CI là E2E.
- **Trước bật production:** chứng minh migrations ở môi trường đích, POS line-level capability, signed quote parity và checkout flow; feature flag Upsell mặc định OFF, bật staging/pilot trước và rollback độc lập qua flag. Đo lỗi add/quote-change, latency và offer→add cơ bản, **không** gửi PII/secrets.
- **Luôn:** validate mọi input ngoài, không để giá phía client quyết định đơn, giữ signed COD proof, không tự chọn quà, không tăng quyền bán stock, không làm checkout hiện có lỗi vì gợi ý. Thay schema, payment/stock/POS contract hoặc production flag phải xin duyệt.

## 7. Nguồn chuẩn

- PR #169 (đã merge): https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/169
- ADR áp dụng: `docs/decisions/0016-gift-quantity-promotions-v1-decisions.md`
- Business spec: `docs/specs/gift-quantity-promotions-v1.md` và `docs/specs/la-na-design-master-spec.md`
- Code authority: `src/commerce/gift-quantity-stack.ts`, `gift-quantity-quote.ts`, `gift-quantity-entitlement.ts`, `benefit-checkout-quote.ts`, `checkout-quote-proof.ts`, `anonymous-cart-mutation.ts`.
- UI hiện hữu: `src/routes/checkout.ts`, `src/components/commerce/guest-checkout-form.tsx`, `src/routes/order-summary-model.ts`.

**Handoff:** Đây là MVP spec với **U-01/A và U-02/A đã được owner duyệt**; **U-03/U-05 còn chờ thiết kế kỹ thuật** và Upsell **chưa implement**. Đừng mở rộng thiết kế phòng ngừa nếu chưa có dữ liệu hoặc test buộc phải làm.

## 8. Amendment AM-01 — phương án A: banner dẫn `/sale` (owner duyệt 17/10/2026)

Nguồn quyết định: OD-01 = **A** trong [storefront-promotion-upsell-checkout-ux-v1.md](storefront-promotion-upsell-checkout-ux-v1.md) §0/UX-07. Đề xuất runtime ban đầu là PR #181; triển khai thực tế đi cùng PR implementation của UX-COMMERCE-001.

| Mục gốc | Thay bằng |
| --- | --- |
| **D-03** chọn biến thể và thêm 1 chiếc tại checkout | Checkout **không** thêm hàng. Khi server có cơ hội hợp lệ (FR-01…FR-05 không đổi), checkout hiện một banner nêu chương trình và nút **“Tiếp tục mua sắm”** dẫn tới `/sale`. Khách tự chọn sản phẩm ở PDP; giỏ và checkout báo giá lại như mọi thay đổi giỏ khác. |
| **D-04 / FR-06 (UI)** hiển thị 1–5 mẫu | Banner không liệt kê mẫu. Giới hạn query/pool của FR-06 vẫn giữ để server chỉ phát banner khi có ứng viên đã chứng minh; không nới giới hạn. |
| **FR-07** giá/estimate từng biến thể | Không hiển thị giá hay chênh tổng tiền ở banner. Copy không hứa mọi sản phẩm ở `/sale` đều thuộc chương trình. |
| **FR-08** thêm an toàn tại checkout | Không có thao tác ghi giỏ từ checkout. Action/proof add của Upsell không còn được UI gọi; giữ ở server cùng test DB cho tới khi có quyết định gỡ riêng. |
| **FR-09 / U-02/A** chọn quà mở nhờ Upsell ngay checkout | Quà mở thêm do khách tự mua thêm được chọn ở `/cart` (picker đầu trang) hoặc ở picker checkout khi quay lại; **picker checkout giữ nguyên**, không tự chọn quà. |
| **FR-12** UI/a11y | Banner gọn là một `section` có tên trong cùng form: tiêu đề “Thêm 1 món để nhận ưu đãi”, tên chương trình, link “Chọn thêm món” tới `/sale` và nút đóng (×) giữ ngữ nghĩa dismiss D-06/FR-10. **Owner quyết định 17/10/2026: không cảnh báo khi rời form đã nhập** — link đi thẳng `/sale`; thông tin đã nhập không được lưu (không ghi PII vào storage) và khách nhập lại khi quay về. Không tự thêm hàng. |

**Test thay thế (AC-16 của UX-COMMERCE-001):** `tests/a11y-runtime/promotion-upsell.spec.ts` kiểm banner, dismiss/reload/A→B→A, đích `/sale`, không lưu PII và a11y; an toàn của add/proof/race vẫn ở `tests/database/promotion-upsell.test.ts`.
