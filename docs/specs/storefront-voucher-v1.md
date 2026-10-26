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
- [ADR 0016 D-12](../decisions/0016-gift-quantity-promotions-v1-decisions.md) (Accepted) quy định ORDER_SUBTOTAL ladder chạy cuối **trong legacy/quantity engine hiện có**. **TG-11 A đã được owner chốt:** giữ D-12 trong engine đó rồi áp voucher **sau** khi toàn bộ tiers hoàn tất. Đây là hợp đồng liên kết engine mới, không sửa ADR hoặc đơn không voucher.
- src/commerce/shipping-campaign.ts: freeship chiến dịch theo paid quantity, không phải freeship vĩnh viễn; PR #198 đã loại bỏ mốc freeship mặc định. Base ship 30.000đ là **giá trị config mặc định**, không hardcode ở voucher. **Quan trọng:** engine hiện có chặn campaign khi có khuyến mãi khác và campaign đặt stackingEnabled=false; tác động của voucher hàng hóa mới phải được mô tả và kiểm thử rõ ở §4.1/TG-10.
- src/commerce/checkout-quote-proof.ts, guest-checkout-snapshot.ts, guest-checkout-submit.ts và pancake-order-submit.ts: server reprice/proof, OrderMirror DRAFT/VALIDATING/POS_SUBMITTING/CONFIRMED/REJECTED/SYNC_UNKNOWN, stock reservation, POS reconciliation.
- src/routes/checkout.ts hiện tạo quote/proof trong loader; cart/page.tsx có `<Link href="/checkout">` được Next.js hỗ trợ prefetch. **GET/render/prefetch không được tự ghi voucher hold/quota**; chỉ mutation từ buyer intent tại §5.1.1/TG-12.
- docs/specs/storefront-funnel-measurement-v1.md: owner mới duyệt **đo Mức 0**; không được thêm durable session sink ngoài approval.

## 1. Bảng quyết định owner — contract sản phẩm

| ID interview | Quyết định đã chốt |
| --- | --- |
| Q01/Q14 | Có voucher tự động và mã; giới thiệu tại PDP, chọn/nhập tại cart & checkout |
| Q02 được thay bởi Q15/Q20 | Tối đa **1 voucher trong mỗi loại**; các loại khác nhau cộng dồn; mặc định tối ưu **tổng thanh toán thấp nhất** |
| Q03/Q04 | Voucher giảm tiền hàng **luôn cộng dồn** với Flash Sale và ưu đãi mua nhiều hiện có |
| Q05/Q18 | Mốc quà theo giá trị đơn xét **sau voucher**; có thể mất quà; cảnh báo và cho khách đổi voucher |
| Q06/Q17/Q19/Q25 | Voucher freeship 100%, kết hợp voucher tiền hàng; mốc tiền xét **sau voucher giảm hàng**; nếu phí ship đã 0 thì không tiêu voucher freeship. **Không suy diễn** câu trả lời này thành quyền bỏ qua cấu hình stackingEnabled của shipping campaign hiện có |
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
| Owner — TG-09 (xác nhận 25/10/2026) | Khi tổng tiền thanh toán bằng nhau, ưu tiên tổ hợp giữ quà cho khách; nếu quyền lợi quà bằng nhau, ưu tiên ít voucher hơn rồi stable ID |
| Owner — TG-05 **A** (25/10/2026) | **Không cưỡng chế thu hồi** hold voucher đã được cấp còn hiệu lực trong 10 phút, kể cả Admin tắt chiến dịch khẩn cấp; chỉ ngừng cấp mới, không bảo đảm tồn kho/giá gốc |
| Owner — TG-10 **B** (25/10/2026) | MERCHANDISE voucher thực giảm được tính là một `other promotion` khi xét `stackingEnabled` của shipping campaign cũ; tự chọn tổng tiền tốt nhất, manual tăng tổng phải cảnh báo/xác nhận |
| Owner — TG-11 **A** (25/10/2026) | `ORDER_SUBTOTAL` ladder được tính sau legacy/quantity nhưng **trước voucher**. Voucher xét ngưỡng/giảm trên giá đã qua tier; không giải lại ladder khi voucher kéo P_after xuống dưới mốc; gift ORDER_SUBTOTAL vẫn tính lại sau voucher |

**Ưu tiên:** Q15/Q20 thay luật cũ “chỉ 1 voucher cả đơn” ở Q02; Q32A quy định phạm vi áp dụng cho Q31C. “Luôn stack với Flash Sale/tier” nghĩa là **áp voucher sau kết quả từ engine hiện có**, không tự ý thay luật xung đột giữa các legacy campaign và tier.

**Trạng thái quyết định:** **TG-05 A, TG-09, TG-10 B và TG-11 A đều đã được owner chốt**. TG-11 A giữ D-12 chạy cuối **trong pre-voucher legacy/quantity stack**, không chạy lại do voucher. Owner policy gate TG-11 đã đóng; các technical gates (regression/quote/POS/browser/concurrency) vẫn phải có bằng chứng trước implementation và ship.

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
- Scope: ALL_SHOP (cho phép **chỉ** excludeProductIds) hoặc TARGETED (categoryKeys và/hoặc includeProductIds, có thể excludeProductIds), dùng taxonomy website hiện tại; exclude luôn thắng. Danh mục là dynamic, sản phẩm mới vào danh mục tự được xét sau membership update. Công thức và ranh giới helper ở §3.3.
- Lifecycle: Draft/Scheduled/Active/Ended/Disabled **derived** từ isEnabled, startsAt, endsAt, enabledAt, disabledAt; time UTC interval [start,end), null bound được phép; campaign tạo mới không tự Active.
- Quota: maxUses nullable (tổng lượt, không theo khách), maxBudgetVnd nullable (whole VND), redeemedUses/redeemedVnd và reservedUses/reservedVnd **hoặc ledger tương đương chứng minh được invariant**. SHIPPING_FREE cost = phí vận chuyển thật được miễn.
- **Admin hạ quota/budget khi có hold (TG-05 A):** reject maxUses mới < **số lượt đã consumed chưa refund + số hold còn hạn**, hoặc maxBudgetVnd mới < **số ngân sách đã consumed chưa refund + budget của hold còn hạn** (cả đổi unlimited → limited). Kiểm tra bằng **cùng transaction và lock order** như grant/consume/release/refund hold; không check-then-write ngoài khóa. Bằng mức đã cam kết thì được nhưng không thể cấp thêm; không được dùng việc sửa giới hạn để hủy hold. Trả lỗi rõ mức trần tối thiểu được phép; Admin có thể disable để ngừng cấp mới mà vẫn honor hold cũ.
- Admin: CRUD/copy/publish/schedule/disable có authorization, shop ownership, optimistic revision và audit. Sửa điều kiện kinh tế tăng revision; không ghi đè lịch sử đơn. Reject incomplete Draft khi publish; reject scope invalid, duplicate code, negative money, invalid time/discount/budget.

### 3.2. Persistence khái niệm

- **VoucherHold:** voucherId + revision, shop scope, cart/checkout attempt server-side identity, quoteDigest, paidCartRevision, heldUse=1, heldDiscountVnd, createdAt/expiresAt, state HELD/CONSUMED/RELEASED/EXPIRED; TTL đúng 10 phút. Không lộ raw cart ID trong URL/token/log.
- **VoucherRedemption / ledger:** orderId + voucherId + kind, revision, amount, websiteAcceptedAt, refundedAt, reconcile evidence, idempotent unique key. Mỗi order tối đa 1 redemption cùng kind, tối đa hai nhóm.
- **Order audit:** immutable snapshot của voucher ID/kind/revision/mức tiền/thuộc nhóm nào, line allocation, shipping winner và tổng chốt; không đọc config hiện thời để quyết định lại giá đơn cũ. Migration additive, tương thích đơn lịch sử.
- Nếu implementation chứng minh schema khác đơn giản hơn nhưng vẫn đúng các invariant thì được dùng; **đề xuất không phải phê duyệt column cụ thể**.

### 3.3. Contract membership của voucher (bổ sung sau review)

Cho product P đang thuộc đúng shop của campaign, dùng **cùng cấp ProductMirror**, không so category theo variant:

- **ALL_SHOP:** eligible(P) = thuộc shop hiện tại AND **P.id không nằm trong excludeProductIds**. Hợp lệ với exclusions; từ chối categoryKeys/includeProductIds đi kèm ALL_SHOP vì dư thừa và gây mơ hồ.
- **TARGETED:** eligible(P) = thuộc shop hiện tại AND **(categoryMatch(P) OR P.id nằm trong includeProductIds) AND P.id không nằm trong excludeProductIds**. Bắt buộc có ít nhất một category hoặc include, không cho scope trống. Category + include là **OR**, không phải AND.
- **categoryMatch:** dùng hệ phân cấp/category expansion hiện tại (kiểm tra các danh mục con tương ứng khi Admin chọn danh mục cha), cùng canonical ProductCategoryMembership.categoryKey. Truy vấn membership động tại thời điểm server quote, không đóng băng tại publish; khi cart/order cần reprice, thay đổi membership phải dẫn đến re-evaluation.
- Tất cả input do Admin ghi phải được normalize/validate bounded theo shop, distinct product IDs, danh mục hợp lệ và loại trừ thắng trong cả hai mode. **Không dùng trực tiếp GLOBAL_ALL_PAID_LINES của gift-quantity-scope.ts cho ALL_SHOP+exclude:** helper đó cố ý từ chối mọi target. Dùng resolver voucher riêng, hoặc mở rộng bằng contract tách biệt không làm thay đổi ngữ nghĩa Gift & Quantity.
- Ví dụ TARGETED: chọn danh mục Đầm + include Túi B + exclude Đầm A ⇒ Đầm khác và Túi B đủ điều kiện, Đầm A bị loại. ALL_SHOP + exclude Túi B ⇒ mọi paid product trừ Túi B; quà không tham gia.

## 4. Pricing contract chính tắc

### 4.1. Thứ tự tính và phạm vi

1. **Thứ tự bắt buộc — TG-11 A đã được owner chốt:** tính paid lines từ cart qua PROMOTION/FLASH_SALE/CLEARANCE và QUANTITY_TIER bằng engine hiện tại. Trong engine này, **ORDER_SUBTOTAL ladder vẫn luôn chạy cuối theo ADR 0016 D-12**, xét paid goods sau legacy và quantity tiers, trước shipping và không gồm gifts; giữ nguyên solver conflicts/priority. Gọi subtotal sau toàn bộ legacy/quantity/tier là **P**. Sau đó voucher MERCHANDISE mới xét ngưỡng trên eligible scoped paid goods và giảm D. **Không** truyền giá đã trừ voucher vào ORDER_SUBTOTAL solver; **không** chạy lại rung đã đạt khi voucher làm P_after thấp hơn ngưỡng; **không** tạo vòng phụ thuộc tier ↔ voucher. Mốc **quà** theo tiền tiếp tục tính lại sau voucher theo Q05. Đây là cách nối voucher sau engine hiện tại, không sửa ADR D-12 hoặc giá đơn không có voucher. Quote/proof/order/Pancake phải bảo toàn thứ tự từng bước.
2. Với voucher hàng hóa có scope S, **E** = subtotal của paid groups thuộc S sau sale/tier, chưa có voucher và ship. Không tính hàng không thuộc scope, gift hay shipping để đạt ngưỡng; nếu E không đạt minimum → ineligible.
3. Voucher MERCHANDISE lấy **D**:
   - FIXED: D = amountVnd; min spend bắt buộc **> D**.
   - PERCENTAGE: D = round-half-up(E × integerPercent / 100), optional cap min(D, maxDiscountVnd). BigInt intermediate, whole VND.
   - Yêu cầu **0 < D < E**; không để paid unit <1đ. Chỉ trừ đúng D trên **paid groups thuộc scope**, không sửa tiền ngoài scope.
   - Allocation xuống POS line/paid segments phải **deterministic và chính xác từng đồng**, ổn định khi đổi thứ tự dòng, bảo toàn quantity/fulfillment, không giảm chồng thêm lần hai. Nếu vendor không thể biểu diễn chính xác D với số lượng/mức giá cụ thể, **block quote/hold/submit** cho candidate đó, không silent rounding: TG-02.
4. **P_after = P − D**. Gift entitlements ORDER_SUBTOTAL được **tính lại sau voucher** theo scope/campaign có sẵn; QUANTITY gifts xét paid quantity. **Preview voucher/tổ hợp không được tự sửa CartGiftSelection đang lưu.** Nếu lựa chọn voucher làm mất suất quà đã chọn, phải đi theo luồng preview → cảnh báo số suất/quà mất → khách xác nhận đổi voucher và bỏ/đổi lựa chọn quà liên quan (hoặc hủy để giữ lựa chọn cũ) → server cập nhật nhất quán → revalidate entitlement và phát quote/proof mới. Cho đến khi xác nhận, chưa commit voucher làm invalid gift; submit bị chặn an toàn như hợp đồng GIFT_SELECTION_INVALID hiện có. Không tự xóa quà, không được xem bấm nút đóng popup là đồng ý.
5. **Đánh giá lại shipping campaign hiện hành cho TỪNG candidate voucher MERCHANDISE**, không tái sử dụng shipping fee từng tính cho candidate khác. Giữ nguyên quy tắc paid quantity/scope/priorities và guard **hasOtherPromotions AND NOT stackingEnabled** của shipping-campaign.ts. **TG-10 B đã được owner duyệt:** hasOtherPromotionsForCandidate = existingPromotionFlag do authority hiện có tính (bao gồm legacy/tier/quà theo contract hiện hành) **OR candidate MERCHANDISE thực sự giảm >0**. Nếu campaign shipping có stackingEnabled=false, chọn voucher tiền hàng có thể khiến campaign đó không còn hợp lệ và phí ship quay lại; khi stackingEnabled=true thì không bị loại chỉ vì voucher. Q03/Q04 bắt buộc cộng với Flash Sale/tier, **không tự động thay** luật stacking của shipping campaign hiện có.
6. Trên **shipping fee thực tế của từng candidate**: nếu fee = 0 nhờ shipping campaign, không áp/hold/consume SHIPPING_FREE voucher. Nếu fee >0, xét SHIPPING_FREE trên subtotal paid **thuộc scope của voucher shipping sau voucher merchandise** (và loại trừ sản phẩm chính xác theo §3.3); đủ min thì fee_after = 0, không đủ thì giữ phí. Quà/ship không được cộng vào threshold; phí không âm. Voucher SHIPPING_FREE là quyền lợi vận chuyển riêng và được cộng với MERCHANDISE khi hợp lệ, nhưng **không nhận hai lần ưu đãi ship**. **Không đưa voucher SHIPPING_FREE vào hasOtherPromotions của shipping campaign lúc xét chính nó**, để tránh vòng lặp; chỉ thêm MERCHANDISE thực giảm theo TG-10 B.
7. **Chống tổng tiền tăng âm thầm:** server so sánh total của mỗi tổ hợp với candidate NONE/NONE cùng cart snapshot. Auto không được chọn tổ hợp khiến tổng tiền cao hơn phương án không dùng voucher. Manual lock hợp lệ vẫn được phép chọn tổ hợp có total cao hơn theo Q21 nhưng UI phải cảnh báo rõ **mất freeship chiến dịch cũ / phí ship tăng / chênh lệch tổng tiền**, yêu cầu xác nhận báo giá mới trước khi commit/submit; không nói voucher luôn làm đơn rẻ hơn. Khi thay giỏ khiến lựa chọn manual tăng tổng, cũng áp cùng quy tắc xác nhận.

**Tổng thanh toán = P_after + shippingFeeAfter**. Cả gift, shipping, order summary và vendor line projection phải lấy từ **cùng một canonical quote**, không tự tính một công thức khác ở cart/checkout/POS.

### 4.2. Tối ưu tổ hợp, manual override

- Candidates: **NONE** + các voucher hợp lệ trong từng nhóm. PRIVATE/CODE chỉ được xét sau khi khách nhập hoặc link đã được xác thực. Một nhóm chỉ có tối đa một voucher chọn.
- Với **cùng cart snapshot, đồng hồ, category membership và price authority**, server tính các cặp candidate (MERCHANDISE/NONE, SHIPPING_FREE/NONE), recheck gift/shipping và khả năng cấp quota/budget **cho các candidate MỚI**; sau đó chọn **totalPayableVnd nhỏ nhất**, bao gồm candidate NONE/NONE. Nếu checkout đã có **hold hợp lệ thuộc chính attempt và quote không đổi**, **không** đòi campaign còn ACTIVE, revision mới bằng revision đã khóa, hay quota **trống** sau khi trừ hold của chính khách: dùng contract hold §5.1. Không dùng hold của attempt khác. **TG-11 A:** các candidate voucher của cùng cart snapshot dùng **cùng giá nền đã qua legacy/quantity/ORDER_SUBTOTAL ladder**; optimizer không đưa voucher-adjusted prices vào tier solver, tránh sai ngưỡng và double-count.
- **Tie-break đã được owner phê duyệt (TG-09):** khi total bằng nhau, ưu tiên tổ hợp **giữ được quà khách đã chọn trước đó**; nếu như nhau, ưu tiên **nhiều suất quà hợp lệ hơn** (không gán quà thành tiền); tiếp theo ít voucher phải tiêu hao hơn, cuối cùng stable ID. Không tự chọn voucher saving 0. **Chỉ** áp dụng tie-break sau bước tối thiểu hóa tổng tiền, không chọn phương án đắt hơn chỉ để giữ quà; tiếp tục tôn trọng manual selection hợp lệ.
- Nếu user manual lock một nhóm, giữ nếu hợp lệ và tối ưu nhóm còn lại; nhập mã ẩn hợp lệ được coi là manual lock. Khi manual mất hiệu lực, auto chọn lại nhóm đó và **thông báo rõ**.
- Khi người mua chỉnh cart/gift, non-held price facts, shipping policy, hoặc hết hold, phải recompute; nếu tổng tiền/entitlement thay đổi, client chỉ được đặt khi đã nhận được **quote/proof mới** và xem/chấp thuận tiền mới. **Riêng sửa/disable voucher ở Admin hoặc voucher hết hạn tự nhiên không tự buộc thay điều khoản voucher của cùng hold còn hợp lệ**; dùng §5.1. Không dùng revision mới của campaign làm điều kiện loại một self-held quote.

### 4.3. Ví dụ bắt buộc

**EX-01 — Joint optimization:** P=620.000đ, shipping=30.000đ, freeship min 600.000đ. Voucher hàng hóa 40K làm P=580K → không freeship → total **610K**. Voucher hàng hóa 20K làm P=600K → freeship → total **600K**. Hệ thống mặc định chọn **20K + freeship**.

**EX-02 — Gift:** P=620K, gift min 600K; voucher 50K còn 570K → **mất quà**; voucher 10K còn 610K → giữ quà. Mặc định optimize money; cảnh báo mất quà và cho đổi voucher.

**EX-03 — Scope:** Đầm 400K + Túi 300K, voucher riêng Đầm min 500K → **ineligible** dù giỏ 700K. Nếu đạt min, giảm chỉ trên Đầm.

**EX-04 — Shipping đã 0:** existing shipping campaign miễn ship trước voucher shipping → voucher SHIPPING_FREE không selected/held/consumed, dù voucher đủ rule.

**EX-05 — Lượt và ngân sách:** quota 1 và hai checkout cùng chọn voucher; chỉ một hold được grant. Mã có quota 100 nhưng maxBudgetVnd 1.000.000đ cũng phải giữ đúng phần budget từng checkout.

**EX-06 — Shipping campaign không cho stack:** giỏ P=100.000đ, campaign freeship đang có hiệu lực với stackingEnabled=false → không dùng voucher total 100.000đ. Thử voucher MERCHANDISE giảm 10.000đ (và không có voucher SHIPPING_FREE hợp lệ) khiến shipping campaign rơi, fee trở lại 30.000đ → total 120.000đ. **Auto phải chọn NONE (100.000đ)**; nếu khách manual chọn giảm 10K thì hiển thị phí ship mới, total tăng 20K và yêu cầu xác nhận tường minh. Với stackingEnabled=true, không được rơi freeship chỉ vì voucher. **TG-10 B đã được owner chốt.**

**EX-07 — Cùng tổng tiền nhưng khác quyền lợi quà:** P=620.000đ, base ship 30K, shipping-voucher min 600K, gift min 600K. Giảm hàng 40K → P_after=580K, fee=30K, total 610K, mất quà. Giảm hàng 10K + SHIPPING_FREE → P_after=610K, fee=0, total **cũng 610K**, giữ quà. Theo tie-break **TG-09 đã chốt**, tự chọn phương án **giữ quà**, trừ khi khách chủ động chọn voucher khác.

**EX-08 — Self-held quota trong natural expiry:** voucher quota=1; khách hold lúc T0 với discount 50K, campaign hết hạn tự nhiên ở T+3 phút, khách submit không đổi cart/quote tại T+5 phút: phải honor **hold riêng còn hạn**, không đòi ACTIVE hay quota free=1. Submit lúc T+10 phút hoặc sau phải từ chối hold hết hạn và re-quote.

**EX-09 — Mốc tier vs gift (TG-11 A ĐÃ CHỐT):** bậc `ORDER_SUBTOTAL` đạt trên giá hàng **trước voucher** và đã giảm qua tier; nếu voucher làm P_after xuống dưới mốc thì bậc tier **không** tính lại. Quà có điều kiện ORDER_SUBTOTAL được tính lại trên P_after; cảnh báo/cho xác nhận khi mất quà.

**EX-10 — TG-11 A chốt ranh giới ADR D-12:** paid goods sau legacy/quantity nhưng trước `ORDER_SUBTOTAL` ladder và voucher = **650.000đ**; ladder min **600.000đ** giảm **30.000đ**; voucher MERCHANDISE giảm **80.000đ** và hợp lệ. **Kết quả 650.000 − 30.000 − 80.000 = 540.000đ**; ngưỡng voucher xét trên **620.000đ** (sau tier), chưa ship. **Không được dùng phương án B 570.000đ** (voucher trước khiến ladder rớt mốc). **Không dùng voucher** phải giữ giá nền **620.000đ trước shipping**. Test quote/proof/snapshot/POS phải khớp từng đồng, không chạy lại tier hoặc double-count.

## 5. Hold 10 phút, dùng lượt tại website, refund

### 5.1. Hold bảo đảm quyền lợi (Q31C/Q32A)

- **Cấm mutation khi read/render:** GET /checkout, RSC/SSR, `loadCheckoutRoute()`, Link prefetch, hover, client mount, PDP/cart/picker preview và reload **không được tạo/renew/release hold hoặc thay đổi voucher reserved capacity**. Voucher hold chỉ được cấp từ buyer-initiated mutation tại §5.1.1, không phát sinh do route loader, `useEffect`, server render hay prefetch.
- Hold tối đa **1 lượt + đúng số VND ngân sách cho mỗi voucher được chọn**, trong **cùng DB transaction** cho hai nhóm; giữ quota/budget của hai voucher theo lock order ổn định để tránh deadlock. Chỉ cấp signed checkout quote đặt hàng được **sau khi** cấp hold cho tất cả voucher được chọn thành công. expiresAt = issuedAt + **10 phút tuyệt đối**, không rolling expiry; tính cap bằng (đã tiêu chưa refund) + (tất cả **hold còn hạn** chưa consume). Khi test quota của chính checkout đang giữ, **loại chính hold của attempt đó khỏi phần quota/đơn vị budget cần cấp mới**; không cộng đôi.
- **Precedence của hold có hiệu lực:** khi submit/re-quote đúng **cart, selected vouchers, signed quote, gift selection và base shipping/price facts** đã khóa, server kiểm tra ownership của hold, quote digest, voucher ID + **revision đã khóa**, discountVnd, expiresAt, trạng thái HELD. Nếu tất cả còn khớp, **honor điều khoản đã snapshot** cho natural campaign expiry và free-quota/budget=0; **không re-run ACTIVE/current revision/free-cap validation** cho voucher đã được hold đó bảo đảm. Vẫn kiểm tra tồn kho, tính khả thi xuất POS và các authority không được hold bảo đảm. Bất cứ trường hợp nào khác phải đi theo re-quote/new hold. Giữ quyền lợi không đồng nghĩa giữ tồn kho, giá cơ sở hay shipping policy ngoài voucher.
- **Khi cart hoặc quote đổi:** old hold **không thể bảo đảm** ưu đãi cho giỏ mới. Trước khi release/rebind, server tính preview trên snapshot mới; thực hiện swap/release + acquire atomically/compensating transaction theo trạng thái, không giải phóng lượt của checkout khác. Không thể cấp new hold thì không báo đã bảo đảm voucher; hiển thị lại tổng mới và yêu cầu xác nhận, tránh mất hold cũ mà vẫn dùng proof cũ.
- **Reload/retry/hai tab** cùng attempt: trả về **cùng hold/expiry** nếu còn phù hợp, không tạo duplicate hay kéo dài thời gian mỗi lần render. Same hold sẽ được CONSUMED **đúng một lần**; concurrent checkout khác không được trừ slot đang giữ.
- **Expiry T+10 phút:** reject consume tại hoặc sau expiresAt (đúng ranh giới thời gian), release idempotent và **bắt buộc re-quote + buyer confirmation**. Worker cleanup không là nguồn xác thực TTL; request phải check expiry trực tiếp trong transaction. Natural campaign expiry ở phút thứ 3 **không** được làm hold chết ở phút thứ 5 (EX-08). Có rate limit/anti-flood chống giữ quota bằng bỏ checkout.
- **TG-05 A đã được owner chốt:** Admin sửa, disable, giảm quota trong mức hợp lệ hoặc emergency stop **chỉ cấm cấp hold mới**, không force-revoke hold đã cấp còn hạn 10 phút. Server honor snapshot benefit khi cart/quote và các facts không được hold khác còn khớp; **không có tính năng Admin cưỡng chế thu hồi existing hold trong MVP**. Không được hạ cap dưới committed floor (§3.1). Nếu tồn kho/giá cơ sở/POS projection bên ngoài voucher khiến checkout không thể hoàn tất, fail closed và báo khách, không âm thầm tăng tiền hoặc viện cớ lỗi để xóa quyền voucher đã giữ.

### 5.1.1. Ranh giới read-only preview → intentional hold (TG-12)

- **GET/prefetch chỉ preview:** render quote, trạng thái đủ điều kiện và mức giảm dự kiến, **không** đặt hold/timer 10 phút. GET có thể phát signed preview proof để chống sửa giá nhưng không được cho submit voucher từ proof preview-only. Nếu đang có hold thật thì GET chỉ đọc và hiển thị hold/expiresAt đó, không gia hạn. Hiển thị rõ `PREVIEW_NOT_HELD` vs `HELD`.
- **Chỉ buyer intent mới cấp hold:** một request **POST/Server Action có xác thực CSRF và idempotency** được kích hoạt từ tương tác thật (CTA “Thanh toán” từ giỏ hàng/buy-now, “Áp dụng” voucher trong checkout, hoặc “Đặt hàng” khi vào checkout trực tiếp). Server đọc authoritative cart, tính quote, lock quota/budget, cấp hold và signed **submit-capable quote bind với hold** trong boundary giao dịch kiểm chứng được. **10 phút bắt đầu tại thời điểm grant hold thành công**, không phải page render.
- **Không tăng số bước bắt buộc:** CTA checkout có thể thực hiện mutation + điều hướng trong một hành động; vào checkout trực tiếp vẫn hiển thị preview tới khi khách chủ động chọn/đặt. Nếu Đặt hàng là hành động đầu tiên, chỉ accept trong chính hành động đó khi quote/giá và mọi guard đã được xác nhận; khi giá hoặc voucher thay đổi phải dừng, hiển thị quote mới và yêu cầu xác nhận.
- **Chống prefetch/duplicate:** Next `<Link>` có thể prefetch; `prefetch={false}` nếu áp dụng chỉ là phòng thủ phụ, **không thay thế ranh giới GET read-only**. Retry cùng attempt/quote dùng lại hold cũ và đúng expiresAt; quote đổi phải swap §5.1. POST rate-limited/CSRF-protected, không tin tiền từ browser.
- **Verification:** chạy production-mode browser/network test cho cart Link prefetch, hover, GET trực tiếp, reload, back/forward và intentional POST. Không một lần GET/prefetch nào tăng heldUses/heldBudget hoặc khởi động TTL; POST mới cấp một hold; UI chỉ hiện “đã giữ” sau khi server xác nhận. Nguồn tài liệu: [Next.js Prefetching](https://nextjs.org/docs/app/guides/prefetching), [Next.js Link](https://nextjs.org/docs/app/api-reference/components/link).


### 5.2. Mốc “website tạo đơn thành công” (Q33B)

**Quan trọng:** OrderMirror DRAFT có thể được tạo khi validate rồi được trả về DRAFT để reprice; **insert DRAFT không đủ** để gọi là đơn thành công.

- Implementation phải xác định **mốc accepted riêng và bền vững**: server đã kiểm tra input, proof, cart version, hold/budget, gift/shipping, đủ điều kiện order và đã ghi sự chấp thuận. **Không đồng nhất với INSERT OrderMirror DRAFT**. Việc ghi accepted marker, **đóng băng immutable order quote/snapshot/voucher identity/amount**, và hold→CONSUMED/redemption phải atomically commit trong một transaction hoặc có cơ chế tương đương với exactly-once effect chứng minh được.
- **Sau accepted, tuyệt đối không mutate/reprice DRAFT như trước accepted**: số tiền hàng/voucher/fee/quà/total và vendor projection đã khóa phải không đổi, kể cả khi Pancake trả PRICE_CHANGED, retry sau lỗi, cart thay đổi hay người mua mở tab khác. Nếu vendor không thể chấp nhận accepted quote, dùng trạng thái reject/reconcile có bằng chứng, refund voucher phù hợp và **yêu cầu checkout attempt mới**; không cập nhật quote của accepted order rồi gửi giá mới. Chỉ đơn chưa accepted mới được phép supersede/reprice DRAFT theo flow hiện hành.
- Trừ lượt khi website accepted, **không đợi Pancake**. Nếu POS_SUBMITTING/SYNC_UNKNOWN thì ledger đã ghi tiêu lượt cho website accepted order. Không ghi lượt nếu request bị từ chối trước accepted (mã sai, quote mismatch, giá đổi, quà invalid). Một order/attempt ID và redemption ledger phải chống replay/double-submit.
- Nếu POS trả **REJECTED có bằng chứng không tạo đơn**, hoàn/trả lại quota/budget idempotent và lưu audit. Nếu **SYNC_UNKNOWN**, giữ pending; không tự hoàn theo timeout hay đoán “không có đơn”; reconciliation bằng POS identity/readback.
- Double-click, replay, hai tab cùng attempt, A→B→A phải giữ một accepted order và không tiêu voucher hai lần. Không phát purchase conversion analytics khi order chưa CONFIRMED theo contract hiện có.

### 5.3. Refund khi hủy (Q24A)

- Khi đơn đã accepted được xác minh **CANCELED** từ nguồn tin cậy (Pancake reconciliation hoặc Admin có quyền với audit), hoàn **một lần** cả lượt và budget đã tiêu, kể cả khi đơn đã bàn giao ship.
- Webhook/status lặp không làm refund lặp; nếu voucher đã expired/disabled thì chỉ hoàn ledger, **không tự kích hoạt** campaign.
- Status ambiguous, lỗi mạng, chưa xác minh mã hủy → pending reconciliation, không tự hoàn. Cần chứng minh mapping trạng thái Pancake (TG-04).

## 6. Public interactions và trust boundary

| Capability | Input từ browser | Thẩm quyền server | Kết quả |
| --- | --- | --- | --- |
| Đọc picker/teaser/checkout preview | GET/surface/intention | Active campaigns, cart, scope, cap, preview quote **read-only, no hold mutation** | Group, disabled reasons, shortfall, selection, total, chưa giữ |
| Nhập mã/link KOL | code bounded | normalize, rate limit, shop scope, eligibility | manual lock nếu hợp lệ, hoặc lỗi rõ và an toàn |
| Chọn/bỏ voucher | ID/intent, có thể NONE | 1 per group, recompute combo, gift + shipping | preview server-derived, chưa giữ quota |
| Cấp checkout hold + submit-capable quote | **Buyer-initiated POST/Server Action** + signed intent/attempt | CSRF, cart ownership, idempotent atomic hold 10 phút + quote/proof bound to hold | signed quote + expiresAt/opaque hold reference, không lộ cart ID/PII |
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
- **Checkout:** một entry ngay order summary, input “Có mã ưu đãi?” mở khi cần, ưu đãi và fee hiển thị đúng quote; giữ nguyên tên, SĐT, địa chỉ, ghi chú, quà khi mở/đóng picker. Buy-now vẫn dùng đúng giỏ mà server quyết định, không áp mã vào sản phẩm tưởng tượng riêng. UI phân biệt “Dự kiến giảm Xđ” (preview) và “Đã giữ ưu đãi đến HH:MM” (POST thành công); không hiển thị countdown hold giả khi chỉ GET/prefetch.

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
- **Quà:** preview tổ hợp làm mất quà trước khi commit; hiển thị rõ số suất đã chọn sẽ không còn hợp lệ, cùng hai nhánh **“Giữ quà / đổi voucher”** hoặc **“Tiếp tục với voucher (bỏ/đổi quà bị mất)”**. Xác nhận tường minh mới cho phép cập nhật voucher và CartGiftSelection liên quan trong giao dịch nhất quán, rồi lập quote mới. Đóng picker/back/cancel **không** đổi voucher đã commit hoặc quà đã chọn. Auto preselect chỉ là preview khi xung đột, không được âm thầm thực thi.
- **Footer:** khi đang có N=1/2 voucher thực sự giảm tiền, nút **“Áp dụng • N ưu đãi”**. N=0: **“Bỏ qua ưu đãi và tiếp tục”**. Bấm chỉ commit selection sau phản hồi server; đóng/back trước khi bấm giữ selection cũ. Không báo thành công chỉ từ click.
- Nếu đang quote/loading, disable submit phù hợp, hiển thị lỗi có lối retry; khi giá tăng hoặc hết giữ chỗ phải hiển thị báo giá mới và yêu cầu đồng ý. **Manual chọn voucher làm shipping campaign cũ mất hiệu lực** phải có cảnh báo dạng “Phí vận chuyển tăng Xđ; tổng đơn tăng Yđ so với không dùng mã”, yêu cầu xác nhận trước khi áp dụng. Không tạo 2 thanh checkout sticky cạnh nhau.

### 7.4. Accessibility & visual QA

- Semantic radio group trong mỗi loại, disabled reason có text (không chỉ làm mờ), touch target ≥44px khi khả thi, focus visible, contrast AA, live region khi selection/total thay đổi.
- Picker modal focus trap, Escape/back đóng và trả focus về trigger; support screen reader, zoom 200%, reduced motion.
- **Ảnh tham chiếu do owner chia sẻ trong chat không tự đính kèm vào repo.** Wireframe và các quy tắc trên là yêu cầu độc lập để coding agent/QA làm việc không cần truy cập ảnh chat.

## 8. Marketing link & public/private

- PUBLIC/AUTO: hiện công khai và tham gia auto optimizer.
- PUBLIC/CODE: có thể hiện công khai, tự tham gia optimizer khi hợp lệ.
- PRIVATE/CODE: chỉ được xét sau khách nhập đúng mã hoặc từ URL (ví dụ **/shop/san-pham?voucher=KOL50**), được ghi như manual choice; không liệt kê khi chưa có mã.
- URL chỉ truyền ý định, không tự cho quyền, trừ tiền hay hold. Validate/normalize/rate limit; **nhận mã từ request đầu trên server và chuyển sang URL sạch trước khi tài liệu tải bên thứ ba (GTM/Meta/analytics)**, ví dụ qua redirect an toàn hoặc cơ chế khác đã kiểm chứng. Lưu ý định mã trong session/cart server-side có expiry thích hợp để đi PDP → cart → checkout mà không phơi mã qua client analytics; áp dụng referrer policy hạn chế và không phát nguyên query vào tracking. **Không chờ đến khi đặt hàng mới xóa query.** URL đã được người gửi/nhà mạng/CDN nhìn thấy không thể hoàn toàn thu hồi; PRIVATE chỉ là không công khai trong picker, không phải secret bảo mật.
- Vì Q08 không giới hạn theo khách, mã KOL được chia sẻ có thể bị người khác dùng; đây là **đặc tính của chính sách**, không coi mã là bí mật bảo mật.

## 9. Security, observability, rollout

### 9.1. Bảo mật/integrity

- Admin RBAC, shop scope, strict bounds/enum/time/code validation, optimistic revision; transaction isolation/lock ordering để đảm bảo không âm, không vượt quota/budget (kể cả đồng thời).
- Idempotent create/consume/swap/release/refund; chống replay/2 tab/overwrite quote, bảo vệ cart HttpOnly và proof HMAC. Rate-limit nhập mã và hold flooding; không để user giữ quá nhiều slot bằng checkout bỏ dở. **Không cấp hold qua GET/render/prefetch/client mount; bắt buộc mutation POST có buyer intent và CSRF.**
- Bound query số voucher/lines/candidates; không N+1 query per card. Một quote phải cùng snapshot clock/cart/campaign; không tự fallback giá cũ khi DB/POS chưa xác nhận.
- Không hiển thị chi tiết ngân sách nội bộ/PII cho buyer, không log private code; analytics không dùng cart ID, attemptKey, phone, address.

### 9.2. Rollout/rollback

- Flag **LA_VOUCHER_ENABLED** mặc định OFF; admin create không auto activate. Schema additive, quote reader cũ giữ lịch sử.
- Test migration + DB concurrency + sandbox Pancake line-level readback trước khi bật. Triển khai phần đọc quote, ledger/reconcile, UI trước; owner tự bật chiến dịch thật sau acceptance.
- Kill switch **chỉ dừng cấp voucher/hold mới**, theo TG-05 A **vẫn honor/consume/reconcile existing valid holds** ngay cả khi flag OFF; không revoke hoặc làm mất giá voucher đã giữ chỉ vì flag bị tắt. Rollback không xóa snapshot hay tính lại tiền các đơn đã được chấp nhận.
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
| AC-05 | Flash Sale/quantity tier/ORDER_SUBTOTAL ladder + voucher | Voucher chạy sau legacy/quantity engine, ADR D-12 ladder cuối trong engine đó; không thay luật conflict hoặc chạy lại ladder do voucher |
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
| AC-24 | Flag OFF/no campaign khi **không có existing valid holds** | Giá/luồng như main, không cấp voucher mới |
| AC-25 | Shop khác, replay, data client giả tiền/scope | Auth/shop/secret boundaries an toàn; không vượt cap |
| AC-26 | Mở/đóng picker trong checkout | Form COD, gift selection không bị xóa; chỉ bấm Áp dụng mới commit |
| AC-27 | Refund khi campaign expired | Ledger hoàn đúng, không tự kích hoạt; counters/budget chính xác |
| AC-28 | Summary/discount/fee | Không double-count sale/tier/voucher/freeship; total reconcile từng đồng |
| AC-29 | EX-06 shipping campaign stackingEnabled=false, fee trước 0 | Theo **TG-10 B đã chốt**: MERCHANDISE là other promotion; auto NONE giữ 100K, manual 10K hiển thị fee 30K + tổng tăng 20K và yêu cầu xác nhận |
| AC-30 | Shipping campaign stackingEnabled=true, khác campaign non-stack; có gift/Flash Sale | Đánh giá hasOtherPromotions đúng authority hiện tại cho **mỗi candidate**; true vẫn freeship, false chỉ khi config không cho; fee/provenance stable |
| AC-31 | EX-08: quota=1 đã hold, natural campaign expiry T+3, submit T+5 | Hold của chính attempt còn hạn được honor, không bị từ chối vì campaign inactive/revision khác/free quota=0 |
| AC-32 | Hết TTL T+10 chính xác, cleanup job chưa chạy | Hold không được consume; release idempotent, bắt buộc re-quote + buyer consent |
| AC-33 | Quote không đổi: reload/2 tab, quota free=0 nhưng self hold còn | Reuse cùng hold/expiry, không double-count quota/budget, không rolling TTL |
| AC-34 | Cart/quote đổi khi hold đang giữ; swap hai nhóm | Không dùng proof/hold cũ cho cart mới; reacquire đúng quota/budget, fail phải báo giá lại |
| AC-35 | Gift đang chọn, auto/manual voucher làm mất quà, khách confirm/cancel | Preview không sửa saved gift; cancel giữ nguyên; confirm cập nhật choice và revalidate/reproof atomically |
| AC-36 | EX-07: hai tổ hợp total=610K nhưng khác số quà giữ được | **TG-09 đã chốt:** chọn tổ hợp giữ quà; nếu như nhau thì chọn ít voucher hơn; không định giá quà thành VND |
| AC-37 | ALL_SHOP + exclude; TARGETED category OR include AND NOT exclude; category cha/con | Membership động và đúng shop, không dùng GLOBAL_ALL_PAID_LINES theo cách phá Gift & Quantity |
| AC-38 | Local accepted marker rồi cart đổi/POS reprice/retry | Voucher/quote/fee/vendor projection immutable; chỉ reject/reconcile, không sửa DRAFT đã accepted |
| AC-39 | `ORDER_SUBTOTAL` ladder đã đạt nhưng voucher khiến P_after xuống dưới mốc | **TG-11 A đã chốt:** không chạy lại bậc tier; gift ORDER_SUBTOTAL theo P_after có thể mất quà và phải cảnh báo |
| AC-40 | Link PRIVATE code và GTM/Meta/referrer | Mã không bị gửi vào analytics/doc load URL sau redirect sang URL sạch; server session giữ intent, request đầu hạn chế log/referrer |
| AC-41 | TG-05 A: Admin edit/disable/emergency kill switch khi hold còn | Không force-revoke existing valid hold trong 10 phút, vẫn honor snapshot nếu checkout facts không đổi; chặn cấp mới |

| AC-42 | GET/RSC/render /checkout, Link prefetch, hover/reload | **Không** tạo/renew/release voucher hold; reservedUses/reservedBudget giữ nguyên; không bắt đầu TTL |
| AC-43 | Buyer click CTA cart/buy-now, picker “Áp dụng” hoặc checkout “Đặt hàng” | POST cấp hold một lần, CSRF/idempotent; retry cùng quote dùng lại expiresAt, preview không giả đã giữ |
| AC-44 | Admin hạ maxUses/maxBudget dưới redeemed chưa refund + active holds | Reject chỉnh sửa, không ảnh hưởng các hold; bằng committed floor thì cho phép nhưng không cấp mới |
| AC-45 | Admin sửa quota đồng thời hai khách POST xin hold | Transaction serialization giữ cap không thấp hơn committed, không oversubscribe/force revoke |
| AC-46 | EX-10: 650K, ladder 600K/30K, voucher 80K | **TG-11 A đã chốt:** tổng hàng sau giảm **540K**, **không** 570K; không voucher **620K** (chưa ship); quote/proof/vendor cùng kết quả |
| AC-47 | Feature flag OFF nhưng trước đó đã cấp hold còn 5 phút | Ngừng cấp mới, vẫn consume/reconcile existing valid hold không silently tăng tiền |


## 11. Project structure, code conventions, test strategy & boundaries

**Intended implementation (không sửa trong PR này):**
- Pure voucher rules/optimizer, quote integration & ledger: src/commerce/voucher-*.ts; áp vào benefit-checkout-quote.ts, checkout-quote-proof.ts, guest-checkout-snapshot.ts và pancake-order-submit.ts (chỉ khi kỹ thuật TG-01/TG-02 được chứng minh).
- Admin: src/app/admin/promotions/... + form; UI picker: src/components/brand/ hoặc src/components/commerce/ + shared route view models; không tính giá trong React.
- Persistence: prisma/schema.prisma + additive migration; order audit snapshot và lifecycle reconcile.
- Tests: tests/domain (pricing, scope, tie, gift, cross-feature D-12 precedence), **tests/integrations** (trong pnpm test: checkout/Pancake, **prefetch/GET read-only**), tests/database (hold, race, **Admin cap concurrency**, accepted/redemption, POS, cancellation), tests/a11y-runtime (picker), browser E2E checkout và sandbox POS contract. Không được chỉ chạy pnpm test:domain + pnpm test:db rồi coi là full regressions.

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
pnpm test
pnpm test:db
pnpm build
~~~

**Boundaries:**
- **Always:** source-driven verification của POS/version, TDD cho money/race, quote→commit→readback parity, a11y, security/PII, rollback/monitoring, human review.
- **Ask owner first:** migration/high-impact API, đổi mốc website accepted order, **bất kỳ force-revoke trái TG-05 A**, **thay đổi thứ tự tier → voucher đã chốt TG-11 A**, chính sách khác với §1, bật campaign có ngân sách thật.
- **Never:** tin tiền/browser, bỏ quote proof, bỏ POS acceptance/readback, chạm đơn committed lịch sử, ghi secret, silently thay quà/giá, coi specs là production enabled.

**Definition of Done:** Spec reviewed; **TG-05 A/TG-09/TG-10 B/TG-11 A đều đã được owner chốt**; technical gates (TG-11 AC-39/46 regression, TG-12 prefetch/mutation, POS/DB races) vẫn cần chứng minh; các AC có tests thực sự, **pnpm test** (gồm tests/integrations) + typecheck/lint/DB/browser/Pancake staging; security/reconciliation/migration/rollback đủ trước ship. Không claim test pass trong spec-only PR.

## 12. Technical gates trước implementation PR

| Gate | Vấn đề source thực tế | Bằng chứng cần có |
| --- | --- | --- |
| TG-01 Website accepted (Q33B) | OrderMirror DRAFT có thể bị reprice, không đồng nghĩa đơn thành công | Chứng minh transaction accepted marker + hold consume + **immutable order quote/snapshot/vendor projection**, không reprice/supersede accepted DRAFT; retry/REJECTED/UNKNOWN đúng; purchase analytics chỉ CONFIRMED |
| TG-02 POS exact money | Pancake có per-line price và gift projection; fixed voucher/order-level allocation có thể không chia hết theo quantity/price segment | Sandbox POS acceptance/readback đầy đủ, giữ signed total chính xác từng đồng; nếu không, block voucher activation/candidate |
| TG-03 10-minute hold + budget | Existing quote HMAC stateless, chưa có durable voucher quota/budget holds | Hold self-ownership/discount/revision snapshot, ACTIVE/quota bypass **chỉ** cho same valid hold khi natural expiry, trừ self hold khi kiểm tra capacity, absolute TTL/rebind/swap trong transaction, DB concurrency + anti-abuse |
| TG-04 Cancellation source | Order status từ Pancake là external, không mặc định suy mọi mã là CANCELED | Map trusted status, verified shop/order, chống duplicate/out-of-order, reconciliation & operator evidence |
| TG-05 Owner hold guarantee — **ĐÃ CHỐT A** | Owner quyết định KHÔNG force-revoke hold đã cấp còn 10 phút, kể cả Admin emergency disable | Stop new holds; honor old holds, reject giảm cap dưới redeemed chưa refund + active holds bằng cùng DB lock/transaction; AC-41/44/45/47 |
| TG-06 Existing stack/quote | Gift, shipping campaign, ADR D-12 pre-voucher ladder và quote/snapshot có contract riêng | Chứng minh tier D-12 cuối trong legacy/quantity stack; voucher chạy sau tier; gift threshold tính sau voucher; proof/versioning, POS/backward compatibility |
| TG-07 UI reference | Hai ảnh Grab chỉ ở conversation, không phải asset repo | Review wireframe §7 và mobile/desktop accessibility acceptance; không phụ thuộc file ảnh chưa có |
| TG-08 Capacity/measurement | Candidate combos + hold có khả năng tăng tải checkout, funnel chỉ Mức 0 | Chốt bounded reads/quoting, benchmark P95, rate-limit hold, metrics không PII và không sink mới |
| TG-09 Owner tie-break — **ĐÃ CHỐT** | Owner xác nhận sau review PR #212 ngày 25/10/2026: **có**, ưu tiên giữ quà khi tổng tiền bằng nhau | Decision closed: giữ quà đã chọn → nhiều suất quà hợp lệ hơn → ít voucher hơn → stable ID; AC-36 vẫn cần test ở implementation |
| TG-10 Owner shipping stacking — **ĐÃ CHỐT B** | MERCHANDISE voucher thực giảm là other promotion khi xét shipping campaign hiện có | hasOtherPromotions = existingFlag OR merchandiseDiscount>0; tôn trọng stackingEnabled, optimizer so NONE, manual tăng tiền phải báo/xác nhận; AC-29/30 |

| TG-11 ADR 0016 D-12 ↔ Voucher v1 — **ĐÃ CHỐT A (owner)** | Owner chọn A: ORDER_SUBTOTAL ladder chạy cuối **pre-voucher legacy/quantity stack**, voucher áp sau tier, không chạy lại ladder vì voucher | Decision closed; technical verification pending: AC-05/39/46 phải chứng minh 650K−30K−80K=540K (không 570K), không voucher=620K; giữ D-12 solver, quote/POS parity |
| TG-12 Checkout hold mutation vs prefetch | Loader checkout render quote/proof, Next Link có prefetch; GET không chứng minh buyer intent | Preview GET/render/prefetch read-only; POST/Server Action có CSRF/idempotency từ buyer intent, quote bind hold; production browser/network AC-42/43 |


**Gate thất bại:** dừng build pricing/submit khi thiếu technical evidence hoặc Pancake chưa xác nhận exact money. **TG-05 A/TG-09/TG-10 B/TG-11 A đã được owner chốt**; TG-11 vẫn cần regression tests, TG-12 cần browser/DB evidence. **Không sửa ADR D-12** trong PR này, không coi CI xanh là voucher E2E pass.

## 13. Related specs / source links

- [Gift & Quantity Promotions](gift-quantity-promotions-v1.md)
- [Shipping Campaigns / PR #198](shipping-campaigns-pr198.md)
- [Promotions / Flash Sale](promotions-flash-sale-v1.md)
- [Smart Promotion Upsell](smart-promotion-upsell-v1.md)
- [Storefront Commerce UX](storefront-promotion-upsell-checkout-ux-v1.md)
- [Funnel Measurement v1](storefront-funnel-measurement-v1.md)
- [Mobile Commerce UX](storefront-mobile-commerce-ux.md)
- [ADR 0016 — Gift Quantity](../decisions/0016-gift-quantity-promotions-v1-decisions.md)

**Owner đã phê duyệt intent và chốt TG-05 A, TG-09, TG-10 B, TG-11 A.** TG-11 A áp voucher sau pre-voucher engine gồm D-12; ADR 0016 giữ nguyên. Chưa có implementation/schema approval, POS acceptance, prefetch mutation evidence hoặc E2E; PR này vẫn **spec-only** trước plan/build.
