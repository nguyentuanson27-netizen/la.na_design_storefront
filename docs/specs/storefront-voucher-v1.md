# SPEC-VOUCHER-001 — Voucher La.Na Design v1 (picker theo nhóm như Grab)

**Trạng thái:** DRAFT — đặc tả để review, không phải code đã triển khai.
**Ngày:** 25/10/2026.
**Nguồn quyết định:** Owner xác nhận intent sau 36 câu interview và ảnh tham chiếu giao diện Grab, trả lời YES ngày 25/10/2026.
**Baseline kỹ thuật:** main@575ebca631b41e26b3385644fcee2ed37a1091b4.
**Phạm vi PR:** Chỉ thêm tài liệu này; **không** sửa runtime, DB, migration, test, CI, flags hoặc kích hoạt voucher.

## 0. Outcome, quyền quyết định và giả định

**Mục tiêu:** Khách không cần săn mã vẫn thấy ưu đãi; mở một picker như Grab để xem voucher đủ điều kiện/chưa đạt mốc, biết thiếu bao nhiêu tiền, chọn tối đa một voucher **mỗi nhóm**, dùng đồng thời hai nhóm, và có tổng thanh toán thấp nhất theo mặc định. Admin tự quản lý chiến dịch và ngân sách; checkout COD guest tiếp tục gọn, không bắt đăng nhập/OTP.

**Thành công:** Luồng PDP → cart → checkout không thêm bước bắt buộc; báo giá, quyền nhận quà, phí ship, quota/budget và tổng đơn trùng khớp giữa render, submit, order snapshot và Pancake. Theo dõi tỷ lệ dùng voucher và chuyển đổi trước/sau nhưng chưa đặt mục tiêu tăng % khi chưa có baseline.

**Authority:** Chỉ server quyết định giá, phạm vi, điều kiện, quyền lợi, giữ chỗ và trạng thái đơn. Client, URL, hình/nhãn voucher không là nguồn tiền. Quyết định thương mại là từ owner; mọi vấn đề chưa có bằng chứng kỹ thuật được ghi thành **technical gate** ở §12, không tự biến thành thay đổi production.

**Bối cảnh:** Next.js 16.4.1, React 19.2.0, TypeScript 5.9, Prisma 7.10.1/PostgreSQL, pnpm 11.4.0 (package.json). Đã có:
- src/commerce/promotion-pricing.ts: promotion/flash sale/clearance từng variant; **campaign legacy trùng nhau không tự stack**.
- src/commerce/gift-quantity-stack.ts, gift-quantity-entitlement.ts, benefit-checkout-quote.ts: ưu đãi mua nhiều, quà, stack và signed quote theo paid groups.
- src/commerce/shipping-campaign.ts: freeship chiến dịch theo paid quantity, không phải freeship vĩnh viễn; PR #198 đã loại bỏ mốc freeship mặc định. Base ship 30.000đ là **giá trị config mặc định**, không hardcode ở voucher.
- src/commerce/checkout-quote-proof.ts, guest-checkout-snapshot.ts, guest-checkout-submit.ts và pancake-order-submit.ts: server reprice/proof, OrderMirror DRAFT/VALIDATING/POS_SUBMITTING/CONFIRMED/REJECTED/SYNC_UNKNOWN, stock reservation, POS reconciliation.
- docs/specs/storefront-funnel-measurement-v1.md: owner mới duyệt **đo Mức 0**; không được thêm durable session sink ngoài approval.

## 1. Bảng quyết định owner — contract sản phẩm

| ID interview | Quyết định đã chốt |
| --- | --- |
| Q01/Q14 | Có voucher tự động và mã; giới thiệu tại PDP, chọn/nhập tại cart & checkout |
| Q02 được thay bởi Q15/Q20 | Tối đa **1 voucher trong mỗi loại**; các loại khác nhau cộng dồn; mặc định tối ưu **tổng thanh toán thấp nhất** |
| Q03/Q04 | Voucher giảm tiền hàng **luôn cộng dồn** với Flash Sale và ưu đãi mua nhiều hiện có |
| Q05/Q18 | Mốc quà theo giá trị đơn xét **sau voucher**; có thể mất quà; cảnh báo và cho khách đổi voucher |
| Q06/Q17/Q19/Q25 | Voucher freeship 100%, kết hợp voucher tiền hàng; mốc tiền xét **sau voucher giảm hàng**; nếu phí ship đã 0 thì không tiêu voucher freeship |
| Q07/Q10/Q11 | Ngưỡng voucher và số tiền giảm xét trên **các paid lines trong phạm vi**, sau Flash Sale/mua nhiều, trước voucher, chưa gồm shipping |
| Q08/Q23/Q24 | Quota **tổng lượt**, không giới hạn theo khách; dùng khi website tạo đơn thành công; **hoàn lượt khi đơn hủy**, kể cả đã giao vận chuyển |
| Q09/Q34/Q35 | Phạm vi áp dụng cho cả hai nhóm: toàn shop/danh mục/sản phẩm cụ thể/loại trừ; danh mục **động**, tự nhận sản phẩm mới |
| Q12/Q13/Q26/Q27/Q36 | % có thể có trần tiền; fixed money bắt buộc ngưỡng lớn hơn giảm; freeship ngưỡng tùy chọn; time và maxBudget tùy chọn |
| Q15/Q21/Q28 | Tự preselect; khách được đổi từng nhóm; giữ manual nếu còn hợp lệ, tối ưu nhóm khác; mã nhập/link được coi là manual selection |
| Q16 | MVP có 2 loại: **MERCHANDISE** (cố định/%), **SHIPPING_FREE** (freeship 100%) |
| Q22/Q29/Q30 | Admin chọn PUBLIC/PRIVATE; PRIVATE chỉ xuất hiện sau khi nhập mã; hiện PUBLIC đủ và gần đạt mốc; hỗ trợ link KOL tự xét mã |
| Q31C cụ thể hóa bởi Q32A | **Giữ quyền lợi voucher trong 10 phút** bằng hold thật, sau hạn phải re-quote. Không bảo đảm giá gốc/tồn kho |
| Q33B | Trừ lượt lúc **website chấp nhận đơn**, không cần đợi POS xác nhận; mốc này không được đồng nhất với bất kỳ DRAFT nào |
| Ảnh Grab + YES | Picker 2 nhóm, item disabled có lý do/“Đặt thêm Xđ…”, sticky footer “Áp dụng • N ưu đãi” |

**Ưu tiên:** Q15/Q20 thay luật cũ “chỉ 1 voucher cả đơn” ở Q02; Q32A quy định phạm vi áp dụng cho Q31C. “Luôn stack với Flash Sale/tier” nghĩa là **áp voucher sau kết quả từ engine hiện có**, không tự ý thay luật xung đột giữa các legacy campaign và tier.

## 2. Phạm vi MVP

### Có

1. Admin tạo/sửa/bật/tắt/lên lịch voucher, mã CODE hoặc tự động AUTO; PUBLIC hoặc PRIVATE; maxUses và maxBudgetVnd tùy chọn.
2. MERCHANDISE giảm số tiền cố định hoặc % (có thể có maxDiscountVnd); SHIPPING_FREE chỉ miễn 100% phí còn phải trả.
3. Scope toàn shop, theo danh mục và/hoặc includeProductIds, excludeProductIds; danh mục động, exclude ưu tiên.
4. Tối đa 1 voucher mỗi loại; chọn tổ hợp tổng tiền thanh toán thấp nhất; lựa chọn tay và nhập mã ẩn được tôn trọng nếu hợp lệ.
5. UI picker như Grab, teaser PDP, entry cart/checkout, thông báo thiếu mốc, mã link KOL, cảnh báo mất quà.
6. Hold quota + budget 10 phút; accepted redemption tại website; refund một lần khi đơn hủy; server quote/POS/audit/monitoring.

### Không có

- Voucher tặng quà riêng; giảm một phần phí ship; wallet/thu thập voucher; >1 voucher cùng loại.
- Giới hạn theo phone/user, OTP/account, voucher khách mới khi chưa có xác minh danh tính.
- Auto-seed voucher/campaign production; thay đổi các ưu đãi đang tồn tại; viết lại engine giá, payment, stock hay POS connector không liên quan.
- Cơ chế “tỷ lệ chuyển đổi theo phiên” mới khi owner chưa duyệt đo Mức 1.

## 3. Domain/lifecycle, scope và Admin

### 3.1. VoucherCampaign (mô hình đề xuất, chưa migration)

- Identity: id, pancakeShopId, name, kind = MERCHANDISE | SHIPPING_FREE, revision, createdAt/updatedAt.
- Issuance: AUTO | CODE; visibility PUBLIC | PRIVATE. **PRIVATE yêu cầu CODE**, AUTO là PUBLIC. CODE/PUBLIC có thể được hiện và tự xét; CODE/PRIVATE không được liệt kê khi chưa nhập.
- Code: normalize canonical, bounded ký tự [A-Z0-9_-], unique theo shop; mã là công cụ phân phối **không phải bảo mật danh tính**, nên có thể được chia sẻ.
- Discount: MERCHANDISE/FIXED_AMOUNT_VND (whole positive VND) hoặc PERCENTAGE (1..99); maxDiscountVnd tùy chọn, chỉ áp dụng cho %. SHIPPING_FREE không có percent/fixed money hàng hóa.
- minEligibleSubtotalVnd nullable với %/shipping; **bắt buộc và > fixedAmountVnd** với giảm số tiền cố định; >0 nếu điền.
- Scope: ALL_SHOP hoặc scope danh mục động (categoryKeys) với include/exclude sản phẩm, cùng taxonomy website hiện tại; exclude thắng include. Sản phẩm mới vào danh mục tự được xét sau membership update.
- Lifecycle: Draft/Scheduled/Active/Ended/Disabled **derived** từ isEnabled, startsAt, endsAt, enabledAt, disabledAt; time UTC interval [start,end), null bound được phép; campaign tạo mới không tự Active.
- Quota: maxUses nullable (tổng lượt, không theo khách), maxBudgetVnd nullable (whole VND), redeemedUses/redeemedVnd và reservedUses/reservedVnd **hoặc ledger tương đương chứng minh được invariant**. SHIPPING_FREE cost = phí vận chuyển thật được miễn.
- Admin: CRUD/copy/publish/schedule/disable có authorization, shop ownership, optimistic revision và audit. Sửa điều kiện kinh tế tăng revision; không ghi đè lịch sử đơn. Reject incomplete Draft khi publish; reject scope invalid, duplicate code, negative money, invalid time/discount/budget.

### 3.2. Persistence khái niệm

- **VoucherHold:** voucherId + revision, shop scope, cart/checkout attempt server-side identity, quoteDigest, paidCartRevision, heldUse=1, heldDiscountVnd, createdAt/expiresAt, state HELD/CONSUMED/RELEASED/EXPIRED; TTL đúng 10 phút. Không lộ raw cart ID trong URL/token/log.
- **VoucherRedemption / ledger:** orderId + voucherId + kind, revision, amount, websiteAcceptedAt, refundedAt, reconcile evidence, idempotent unique key. Mỗi order tối đa 1 redemption cùng kind, tối đa hai nhóm.
- **Order audit:** immutable snapshot của voucher ID/kind/revision/mức tiền/thuộc nhóm nào, line allocation, shipping winner và tổng chốt; không đọc config hiện thời để quyết định lại giá đơn cũ. Migration additive, tương thích đơn lịch sử.
- Nếu implementation chứng minh schema khác đơn giản hơn nhưng vẫn đúng các invariant thì được dùng; **đề xuất không phải phê duyệt column cụ thể**.

## 4. Pricing contract chính tắc

### 4.1. Thứ tự tính và phạm vi

1. Tính paid lines từ authoritative cart và giá sau legacy PROMOTION/FLASH_SALE/CLEARANCE + QUANTITY_TIER bằng engine hiện tại. Gọi tổng tiền paid sau các giảm cũ là **P**. Quà chưa thêm vào tiền hàng.
2. Với voucher hàng hóa có scope S, **E** = subtotal của paid groups thuộc S sau sale/tier, chưa có voucher và ship. Không tính hàng không thuộc scope, gift hay shipping để đạt ngưỡng; nếu E không đạt minimum → ineligible.
3. Voucher MERCHANDISE lấy **D**:
   - FIXED: D = amountVnd; min spend bắt buộc **> D**.
   - PERCENTAGE: D = round-half-up(E × integerPercent / 100), optional cap min(D, maxDiscountVnd). BigInt intermediate, whole VND.
   - Yêu cầu **0 < D < E**; không để paid unit <1đ. Chỉ trừ đúng D trên **paid groups thuộc scope**, không sửa tiền ngoài scope.
   - Allocation xuống POS line/paid segments phải **deterministic và chính xác từng đồng**, ổn định khi đổi thứ tự dòng, bảo toàn quantity/fulfillment, không giảm chồng thêm lần hai. Nếu vendor không thể biểu diễn chính xác D với số lượng/mức giá cụ thể, **block quote/hold/submit** cho candidate đó, không silent rounding: TG-02.
4. **P_after = P − D**. Gift entitlements ORDER_SUBTOTAL được **tính lại sau voucher** theo scope/campaign có sẵn; QUANTITY gifts xét paid quantity. Nếu mất suất đang chọn, cho khách biết và xác nhận/đổi voucher/quà trước submit; **không tự xóa CartGiftSelection** không có đồng ý.
5. Tính shipping campaign hiện hành theo own scope/paid quantity/stacking (PR #198). Nếu fee đã 0 thì SHIPPING_FREE voucher không tham gia.
6. Nếu fee >0, voucher SHIPPING_FREE đủ điều kiện khi subtotal paid **thuộc scope của voucher shipping sau voucher merchandise** đạt min (nếu có). Fee_after = 0; nếu không đủ thì giữ fee hiện tại. Quà/ship không được cộng vào threshold. Voucher không biến phí ship âm.

**Tổng thanh toán = P_after + shippingFeeAfter**. Cả gift, shipping, order summary và vendor line projection phải lấy từ **cùng một canonical quote**, không tự tính một công thức khác ở cart/checkout/POS.

### 4.2. Tối ưu tổ hợp, manual override

- Candidates: **NONE** + các voucher hợp lệ trong từng nhóm. PRIVATE/CODE chỉ được xét sau khi khách nhập hoặc link đã được xác thực. Một nhóm chỉ có tối đa một voucher chọn.
- Với **cùng cart snapshot, đồng hồ, category membership, campaign revision**, server tính các cặp candidate (MERCHANDISE/NONE, SHIPPING_FREE/NONE), recheck quota/budget và gift/shipping, rồi chọn **totalPayableVnd nhỏ nhất**.
- Khi hai phương án có tổng bằng nhau, ưu tiên **ít voucher phải tiêu hao hơn**, rồi stable ID tie-break. Không tự chọn voucher saving 0; ưu đãi quà không được giả định là tiền để biến mục tiêu tối ưu thành mục tiêu khác.
- Nếu user manual lock một nhóm, giữ nếu hợp lệ và tối ưu nhóm còn lại; nhập mã ẩn hợp lệ được coi là manual lock. Khi manual mất hiệu lực, auto chọn lại nhóm đó và **thông báo rõ**.
- Khi người mua chỉnh cart/gift, thay quote, campaign đổi, hoặc hết hold, phải recompute; nếu tổng tiền/entitlement thay đổi, client chỉ được đặt khi đã nhận được **quote/proof mới** và xem/chấp thuận tiền mới.

### 4.3. Ví dụ bắt buộc

**EX-01 — Joint optimization:** P=620.000đ, shipping=30.000đ, freeship min 600.000đ. Voucher hàng hóa 40K làm P=580K → không freeship → total **610K**. Voucher hàng hóa 20K làm P=600K → freeship → total **600K**. Hệ thống mặc định chọn **20K + freeship**.

**EX-02 — Gift:** P=620K, gift min 600K; voucher 50K còn 570K → **mất quà**; voucher 10K còn 610K → giữ quà. Mặc định optimize money; cảnh báo mất quà và cho đổi voucher.

**EX-03 — Scope:** Đầm 400K + Túi 300K, voucher riêng Đầm min 500K → **ineligible** dù giỏ 700K. Nếu đạt min, giảm chỉ trên Đầm.

**EX-04 — Shipping đã 0:** existing shipping campaign miễn ship trước voucher shipping → voucher SHIPPING_FREE không selected/held/consumed, dù voucher đủ rule.

**EX-05 — Lượt và ngân sách:** quota 1 và hai checkout cùng chọn voucher; chỉ một hold được grant. Mã có quota 100 nhưng maxBudgetVnd 1.000.000đ cũng phải giữ đúng phần budget từng checkout.

## 5. Hold 10 phút, dùng lượt tại website, refund

### 5.1. Hold bảo đảm quyền lợi (Q31C/Q32A)

- **Chỉ cấp hold khi checkout phát hành quote đủ điều kiện**, không giữ lượt vì người dùng xem PDP, picker/cart hoặc gõ thử code.
- Hold tối đa **1 lượt + đúng số VND ngân sách cho mỗi voucher được chọn**, cùng giao dịch DB. Giữ chỗ thành công lúc issuedAt; expiresAt = issuedAt + 10 phút. Hệ thống không over-allocate khi có concurrent users.
- Natural expiry của campaign hoặc quota bị người khác dùng hết **trong 10 phút** không phá quyền lợi voucher đã giữ của **quote/cart không thay đổi**. Không dùng hold để bảo đảm stock, giữ giá cơ sở hoặc shipping policy khác.
- Reload/retry/2 tab không sinh hold mới hoặc kéo dài vô hạn một attempt; đổi voucher phải swap/release có khóa nhất quán. Nếu đổi cart/line quantity/eligibility/quote revision, báo giá lại và rebind hold; không tự hứa ưu đãi chưa giữ được.
- Hết 10 phút phải release (idempotent) và **yêu cầu refresh quote, xem tổng mới, xác nhận lại** trước đặt hàng. Job dọn TTL là phụ; DB live check/transaction quyết định correctness. Có rate limit/guard chống chiếm slot bằng nhiều abandoned carts.
- Admin emergency disable/revoke khi đã có hold là **technical owner gate TG-05**, không được âm thầm tăng tiền hoặc thu hồi khi khách chưa được báo.

### 5.2. Mốc “website tạo đơn thành công” (Q33B)

**Quan trọng:** OrderMirror DRAFT có thể được tạo khi validate rồi được trả về DRAFT để reprice; **insert DRAFT không đủ** để gọi là đơn thành công.

- Implementation phải xác định một **local checkout accepted marker bền**: server đã kiểm tra input, proof, cart version, hold/budget, gift/shipping, đủ điều kiện order và ghi nhận chấp thuận vào DB. Marker và hold→CONSUMED/redemption cần chung transaction hoặc cơ chế tương đương có bằng chứng exactly-once effect.
- Trừ lượt khi website accepted, **không đợi Pancake**. Nếu POS_SUBMITTING/SYNC_UNKNOWN thì ledger đã ghi tiêu lượt cho website accepted order. Không ghi lượt nếu request bị từ chối trước accepted (mã sai, quote mismatch, giá đổi, quà invalid).
- Nếu POS trả **REJECTED có bằng chứng không tạo đơn**, hoàn/trả lại quota/budget idempotent và lưu audit. Nếu **SYNC_UNKNOWN**, giữ pending; không tự hoàn theo timeout hay đoán “không có đơn”; reconciliation bằng POS identity/readback.
- Double-click, replay, hai tab cùng attempt, A→B→A phải giữ một accepted order và không tiêu voucher hai lần. Không phát purchase conversion analytics khi order chưa CONFIRMED theo contract hiện có.

### 5.3. Refund khi hủy (Q24A)

- Khi đơn đã accepted được xác minh **CANCELED** từ nguồn tin cậy (Pancake reconciliation hoặc Admin có quyền với audit), hoàn **một lần** cả lượt và budget đã tiêu, kể cả khi đơn đã bàn giao ship.
- Webhook/status lặp không làm refund lặp; nếu voucher đã expired/disabled thì chỉ hoàn ledger, **không tự kích hoạt** campaign.
- Status ambiguous, lỗi mạng, chưa xác minh mã hủy → pending reconciliation, không tự hoàn. Cần chứng minh mapping trạng thái Pancake (TG-04).

## 6. Public interactions và trust boundary

| Capability | Input từ browser | Thẩm quyền server | Kết quả |
| --- | --- | --- | --- |
| Đọc picker/teaser | surface/intention | active public campaigns, cart, scope, cap, current quote | nhóm, disabled reasons, shortfall, selection, savings |
| Nhập mã/link KOL | code bounded | normalize, rate limit, shop scope, eligibility | manual lock nếu hợp lệ, hoặc lỗi rõ và an toàn |
| Chọn/bỏ voucher | ID/intent, có thể NONE | 1 per group, recompute combo, gift + shipping | preview server-derived, chưa giữ quota |
| Issue checkout quote | cart + user intent server known | hold atomic 10 phút + quote/proof | signed quote, không lộ cart ID/PII |
| Submit | COD form + proof | verify quote/current cart/hold/accepted marker | idempotent order result, snapshot + ledger |
| Cancel/reconcile | trusted POS status/authenticated admin | verify source, CAS refund once | counters/budget/snapshots chính xác |
| Admin CRUD | bounded form fields | RBAC, shop authorization, revision, lifecycle | audit, không bật chiến dịch bất ngờ |

- Không tin price, quota, product scope, eligibility hoặc shipping amount từ client. Voucher code và link marketing là input **không tin cậy**, không là chứng thực/ownership.
- Không log token/cookie raw cart, PII, private voucher code; analytics không phát mã riêng vào URL/event. Quote HMAC stateless hiện tại **không thay thế** DB hold bền; proof phải bind selected voucher IDs/revision/actual discount/fee/entitlement cùng order quote.
- Nếu service đọc voucher/counter lỗi, trạng thái **unavailable khác với no voucher**: không được bỏ giảm giá rồi silently chốt với tiền cao hơn. Thay vào đó retry hoặc hiển thị quote mới cần xác nhận.

## 7. UX picker lấy cảm hứng từ ảnh Grab

### 7.1. PDP/cart/checkout

- **PDP:** teaser nhỏ ngay khu vực giá/CTA: 1–2 ưu đãi công khai liên quan sản phẩm + “Xem tất cả”. Khi chưa có variant/cart rõ thì chỉ mô tả điều kiện, không khẳng định khách chắc chắn đủ voucher; không hold.
- **Cart page/drawer:** block “Ưu đãi”, hiển thị các voucher đang dùng, tiền giảm và “Chọn/đổi ưu đãi”; hiển thị near-threshold một cách gọn, **không trùng** các progress bars của PromotionBanner/quà. Không đẩy nút mua xuống xa.
- **Checkout:** một entry ngay order summary, input “Có mã ưu đãi?” mở khi cần, ưu đãi và fee hiển thị đúng quote; giữ nguyên tên, SĐT, địa chỉ, ghi chú, quà khi mở/đóng picker. Buy-now vẫn dùng đúng giỏ mà server quyết định, không áp mã vào sản phẩm tưởng tượng riêng.

### 7.2. Full-screen mobile, panel desktop

Mobile có header **“Ưu đãi”**, back, ô nhập mã, phần danh sách voucher cuộn bên dưới, footer sticky không che safe area. Desktop có dialog/side-panel focus management.

Wireframe tham chiếu **hành vi** (không sao chép logo, icon, màu hay hình Grab):

~~~text
<   Ưu đãi
[ Nhập mã khuyến mãi                              ]

Voucher giảm tiền hàng                     Chọn 1
[✓] Giảm 30.000đ    Đơn Đầm từ 600.000đ
[ ] Giảm 10%        Tối đa 100.000đ
[ ] Giảm 53.000đ    Đặt thêm 160.500đ để được hưởng
                    (chưa đủ điều kiện, hiện mờ)

Voucher vận chuyển                          Chọn 1
[✓] Miễn phí vận chuyển   Đơn từ 500.000đ
[ ] Miễn phí vận chuyển   Đặt thêm 60.000đ

[ Áp dụng • 2 ưu đãi                              ]
~~~

### 7.3. Card/selection/feedback

- **Selected:** dấu chọn dễ nhận biết. **Eligible unselected vẫn bấm chọn được**, đổi voucher cùng nhóm là **thay thế** chứ không cộng dồn. Mỗi nhóm có chọn **Không dùng voucher**; chủ động NONE phải được giữ như manual choice.
- **Near threshold:** disabled nhưng đọc rõ, dòng **“Đặt thêm Xđ để được hưởng ưu đãi này”**. X lấy từ **server eligible subtotal trong phạm vi đúng**, sau sale/tier và voucher tiền hàng đã chọn nếu xét freeship. Requote sau khi thêm hàng; không quảng bá X như bảo đảm tuyệt đối nếu giảm giá thay đổi cùng giỏ.
- **Ineligible khác:** rõ lý do “Hết lượt”, “Đã hết hạn”, “Không áp dụng cho sản phẩm”, “Không thể kết hợp với lựa chọn hiện tại”. PRIVATE chưa nhập **không** lộ trong list; sau khi nhập sai có thông báo không làm lộ private campaign inventory.
- **Tự động:** server preselect combo có tổng cuối thấp nhất; không gắn nhãn “Tốt nhất” khi chưa được server xác minh. **Manual:** đổi nhóm đó vẫn chọn cứng nếu hợp lệ; nhóm còn lại auto. Nếu manual invalid, auto-reselect và thông báo.
- **Quà:** khi voucher làm mất quà theo giá trị đơn, cảnh báo trước “Dùng ưu đãi này sẽ không còn đủ điều kiện nhận X quà”, cho đổi. Không tự xóa saved gift selection khi chưa xác nhận.
- **Footer:** khi đang có N=1/2 voucher thực sự giảm tiền, nút **“Áp dụng • N ưu đãi”**. N=0: **“Bỏ qua ưu đãi và tiếp tục”**. Bấm chỉ commit selection sau phản hồi server; đóng/back trước khi bấm giữ selection cũ. Không báo thành công chỉ từ click.
- Nếu đang quote/loading, disable submit phù hợp, hiển thị lỗi có lối retry; khi giá tăng hoặc hết giữ chỗ phải hiển thị báo giá mới và yêu cầu đồng ý. Không tạo 2 thanh checkout sticky cạnh nhau.

### 7.4. Accessibility & visual QA

- Semantic radio group trong mỗi loại, disabled reason có text (không chỉ làm mờ), touch target ≥44px khi khả thi, focus visible, contrast AA, live region khi selection/total thay đổi.
- Picker modal focus trap, Escape/back đóng và trả focus về trigger; support screen reader, zoom 200%, reduced motion.
- **Ảnh tham chiếu do owner chia sẻ trong chat không tự đính kèm vào repo.** Wireframe và các quy tắc trên là yêu cầu độc lập để coding agent/QA làm việc không cần truy cập ảnh chat.

## 8. Marketing link & public/private

- PUBLIC/AUTO: hiện công khai và tham gia auto optimizer.
- PUBLIC/CODE: có thể hiện công khai, tự tham gia optimizer khi hợp lệ.
- PRIVATE/CODE: chỉ được xét sau khách nhập đúng mã hoặc từ URL (ví dụ **/shop/san-pham?voucher=KOL50**), được ghi như manual choice; không liệt kê khi chưa có mã.
- URL chỉ truyền ý định, không tự cho quyền, trừ tiền hay hold. Validate/normalize/rate limit, duy trì ý định qua PDP → cart → checkout; sau consume loại query khỏi URL để hạn chế referrer/history. Không log raw code PRIVATE hoặc gắn vào analytics.
- Vì Q08 không giới hạn theo khách, mã KOL được chia sẻ có thể bị người khác dùng; đây là **đặc tính của chính sách**, không coi mã là bí mật bảo mật.

## 9. Security, observability, rollout

### 9.1. Bảo mật/integrity

- Admin RBAC, shop scope, strict bounds/enum/time/code validation, optimistic revision; transaction isolation/lock ordering để đảm bảo không âm, không vượt quota/budget (kể cả đồng thời).
- Idempotent create/consume/swap/release/refund; chống replay/2 tab/overwrite quote, bảo vệ cart HttpOnly và proof HMAC. Rate-limit nhập mã và hold flooding; không để user giữ quá nhiều slot bằng checkout bỏ dở.
- Bound query số voucher/lines/candidates; không N+1 query per card. Một quote phải cùng snapshot clock/cart/campaign; không tự fallback giá cũ khi DB/POS chưa xác nhận.
- Không hiển thị chi tiết ngân sách nội bộ/PII cho buyer, không log private code; analytics không dùng cart ID, attemptKey, phone, address.

### 9.2. Rollout/rollback

- Flag **LA_VOUCHER_ENABLED** mặc định OFF; admin create không auto activate. Schema additive, quote reader cũ giữ lịch sử.
- Test migration + DB concurrency + sandbox Pancake line-level readback trước khi bật. Triển khai phần đọc quote, ledger/reconcile, UI trước; owner tự bật chiến dịch thật sau acceptance.
- Kill switch **dừng cấp voucher/hold mới**, giữ đường settle các hold/usage đã tồn tại. Rollback không xóa snapshot hay tính lại tiền các đơn đã được chấp nhận.
- Không merge spec đồng nghĩa deploy voucher. Bất cứ ý định “mở mặc định” đều cần approval riêng.

### 9.3. Đo lường

- Tech metrics có thể kiểm chứng từ server: active campaigns, quote candidates, hold success/expired/conflict, redemptions, refunds, budget, POS pending/unknown/reconciliation, price mismatch, fee saved.
- UX observations: picker open, code attempt, selection đổi, near-threshold displayed (không nhầm với conversion). Business outcome: voucher used chỉ sau **accepted**; purchase conversion chỉ khi **CONFIRMED** theo hợp đồng hiện có.
- Không thêm durable first-party per-session sink trái **OD-02 = Mức 0** ở docs/specs/storefront-funnel-measurement-v1.md. Đánh giá trước/sau theo traffic/chiến dịch comparable, không tuyên bố uplift khi chưa có dữ liệu.

## 10. Acceptance criteria

| ID | Kịch bản / bằng chứng bắt buộc | Pass nếu |
| --- | --- | --- |
| AC-01 | 2 voucher hàng hóa cùng eligible | Tối đa 1 được chọn; chọn cái khác thay cái trước |
| AC-02 | 1 hàng hóa + 1 freeship cùng eligible | Tổng chính xác sau cả hai; không chồng >1 mỗi loại |
| AC-03 | EX-01 40K vs 20K+freeship | Auto chọn **600K**, không phải 610K |
| AC-04 | Manual lock một nhóm, cart đổi | Giữ nếu còn hợp lệ, tối ưu nhóm kia; invalid mới tự thay kèm thông báo |
| AC-05 | Flash Sale/tier + voucher | Voucher luôn áp sau engine có sẵn; giữ quy tắc conflict giữa campaign cũ |
| AC-06 | EX-03 Đầm 400K/Túi 300K, min 500K | Không đủ; chỉ scope Đầm tính ngưỡng/discount; danh mục dynamic |
| AC-07 | Fixed giảm >= min; % trần tùy chọn | Admin không publish fixed invalid; không paid unit có giá 0/âm |
| AC-08 | EX-02 gift threshold 600K | Voucher 50K làm mất quà, cảnh báo; đổi 10K giữ quà được |
| AC-09 | Shipping min 600K nhưng sau voucher chỉ 570K | Voucher freeship ineligible |
| AC-10 | Shipping campaign hiện tại fee=0 | Voucher shipping saving=0 không selected/held/consumed |
| AC-11 | Public near threshold | Card disabled có “Đặt thêm Xđ…” đúng scope/price server |
| AC-12 | UI mobile và desktop | 2 nhóm, manual radio, input, disabled reasons, footer “Áp dụng • N ưu đãi”, keyboard/focus |
| AC-13 | PRIVATE code, link KOL, invalid code | Không lộ code ẩn, đúng mã được manual lock, sai mã an toàn + rate-limit |
| AC-14 | Quota 1/budget giới hạn; 2 checkout đồng thời | Chỉ hold hợp lệ trong cap, không race oversubscribe |
| AC-15 | Hold còn 9m59s rồi natural expiry, đến 10m | Hold được bảo vệ trong TTL; hết 10m re-quote, không silently tăng total |
| AC-16 | Reload/retry/2 tab/swap voucher | Không duplicate hold, không kéo dài TTL vô hạn, budget không âm |
| AC-17 | Website accepted order, POS đang xử lý | Voucher CONSUMED đúng một lần, không cần đợi POS confirm |
| AC-18 | POS REJECTED có chứng cứ vs SYNC_UNKNOWN | Definitive reject settle/refund; UNKNOWN giữ pending, không tự trả |
| AC-19 | Đơn hủy sau vận chuyển, cancel event lặp | Refund đúng một lần cả quota và budget; không tự bật voucher hết hạn |
| AC-20 | POS không biểu diễn được discount exact theo lines | Không quote/submit sai giá; phải có gate POS acceptance |
| AC-21 | Admin disable/edit khi có hold | History không đổi, behavior in-flight đúng decision TG-05 |
| AC-22 | PDP/cart/checkout/commit/Pancake | Cùng discount, shipping, gift, total; signed proof stale phải reconfirm |
| AC-23 | Voucher DB lỗi, quote proof invalid | Không tự chốt tiền cao hơn; retry/reconfirm rõ, fail closed |
| AC-24 | Flag OFF hoặc không có chiến dịch | Luồng và giá như main, không phát sinh voucher use |
| AC-25 | Shop khác, replay, data client giả tiền/scope | Auth/shop/secret boundaries an toàn; không vượt cap |
| AC-26 | Mở/đóng picker trong checkout | Form COD, gift selection không bị xóa; chỉ bấm Áp dụng mới commit |
| AC-27 | Refund khi campaign expired | Ledger hoàn đúng, không tự kích hoạt; counters/budget chính xác |
| AC-28 | Summary/discount/fee | Không double-count sale/tier/voucher/freeship; total reconcile từng đồng |

## 11. Project structure, code conventions, test strategy & boundaries

**Intended implementation (không sửa trong PR này):**
- Pure voucher rules/optimizer, quote integration & ledger: src/commerce/voucher-*.ts; áp vào benefit-checkout-quote.ts, checkout-quote-proof.ts, guest-checkout-snapshot.ts và pancake-order-submit.ts (chỉ khi kỹ thuật TG-01/TG-02 được chứng minh).
- Admin: src/app/admin/promotions/... + form; UI picker: src/components/brand/ hoặc src/components/commerce/ + shared route view models; không tính giá trong React.
- Persistence: prisma/schema.prisma + additive migration; order audit snapshot và lifecycle reconcile.
- Tests: tests/domain (pricing, scope, tie, gift), tests/database (hold, race, accepted/redemption, POS, cancellation), tests/a11y-runtime (picker), browser E2E checkout và sandbox POS contract.

**Code style:** pure calculator, Readonly types và BigInt cho intermediate money, stable deterministic sorting, return typed result/error, không mutate global campaign state để tính candidate. Ví dụ pseudocode:

~~~ts
type VoucherSelection = Readonly<{
  merchandiseVoucherId: string | null;
  shippingVoucherId: string | null;
  manuallyLockedKinds: readonly ("MERCHANDISE" | "SHIPPING_FREE")[];
}>;
// Browser chỉ được gửi intent, server phát hành quote và price authority.
~~~

**Commands cần chạy khi có implementation** (Node ≥22.14, env test DB/POS được cấu hình):

~~~bash
pnpm prisma:validate
pnpm prisma:generate
pnpm typecheck
pnpm lint
pnpm test:domain
pnpm test:db
pnpm build
~~~

**Boundaries:**
- **Always:** source-driven verification của POS/version, TDD cho money/race, quote→commit→readback parity, a11y, security/PII, rollback/monitoring, human review.
- **Ask owner first:** migration/high-impact API, đổi mốc website accepted order, emergency revoke hold, chính sách khác với decisions §1, bật chiến dịch có ngân sách thật.
- **Never:** tin tiền/browser, bỏ quote proof, bỏ POS acceptance/readback, chạm đơn committed lịch sử, ghi secret, silently thay quà/giá, coi specs là production enabled.

**Definition of Done:** Spec reviewed; technical gates được giải quyết; AC có tests thực sự, typecheck/lint/DB/browser và Pancake staging evidence; security/reconciliation/migration/rollback đủ trước ship. Không claim test pass trong spec-only PR.

## 12. Technical gates trước implementation PR

| Gate | Vấn đề source thực tế | Bằng chứng cần có |
| --- | --- | --- |
| TG-01 Website accepted (Q33B) | OrderMirror DRAFT có thể bị reprice, không đồng nghĩa đơn thành công | Xác định atomic local accepted boundary + durable marker, state transitions/retries với VALIDATING/POS_SUBMITTING/REJECTED/SYNC_UNKNOWN; không ảnh hưởng purchase analytics |
| TG-02 POS exact money | Pancake có per-line price và gift projection; fixed voucher/order-level allocation có thể không chia hết theo quantity/price segment | Sandbox POS acceptance/readback đầy đủ, giữ signed total chính xác từng đồng; nếu không, block voucher activation/candidate |
| TG-03 10-minute hold + budget | Existing quote HMAC stateless, chưa có durable voucher quota/budget holds | Schema/transaction/CAS, lock order, release expiry/swap, concurrency & anti-abuse tests; quote/cart binding |
| TG-04 Cancellation source | Order status từ Pancake là external, không mặc định suy mọi mã là CANCELED | Map trusted status, verified shop/order, chống duplicate/out-of-order, reconciliation & operator evidence |
| TG-05 Emergency revoke | Q32 bảo đảm hold qua natural expiry, chưa có quyết định về thu hồi khẩn cấp do campaign cấu hình sai | Đề xuất owner phê duyệt: stop new holds, cách xử lý hold đã cấp và thông báo; không âm thầm phá promise |
| TG-06 Existing stack/quote | Gift, shipping campaign, immutable OrderQuoteSnapshot và quote proof đang có contracts riêng | Chỉ ra thứ tự/tính lại entitlement và shipping, new voucher ledger, signed proof versioning, backward compat tests |
| TG-07 UI reference | Hai ảnh Grab chỉ ở conversation, không phải asset repo | Review wireframe §7 và mobile/desktop accessibility acceptance; không phụ thuộc file ảnh chưa có |
| TG-08 Capacity/measurement | Candidate combos + hold có khả năng tăng tải checkout, funnel chỉ Mức 0 | Chốt bounded reads/quoting, benchmark P95, rate-limit hold, metrics không PII và không sink mới |

**Gate thất bại:** dừng build phần pricing/submit liên quan, không ship một hệ thống voucher báo giá mà vendor không thể cam kết; đề xuất giải pháp/tối giản scope để owner xét.

## 13. Related specs / source links

- [Gift & Quantity Promotions](gift-quantity-promotions-v1.md)
- [Shipping Campaigns / PR #198](shipping-campaigns-pr198.md)
- [Promotions / Flash Sale](promotions-flash-sale-v1.md)
- [Smart Promotion Upsell](smart-promotion-upsell-v1.md)
- [Storefront Commerce UX](storefront-promotion-upsell-checkout-ux-v1.md)
- [Funnel Measurement v1](storefront-funnel-measurement-v1.md)
- [Mobile Commerce UX](storefront-mobile-commerce-ux.md)
- [ADR 0016 — Gift Quantity](../decisions/0016-gift-quantity-promotions-v1-decisions.md)

**Owner YES là phê duyệt intent**, chưa phải chấp thuận schema/technical choices hay chứng minh POS. PR này đưa spec vào repository để review **trước plan và implementation**.
