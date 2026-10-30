# SPEC-PRM-002 — Khuyến mại tặng sản phẩm và giảm giá theo số lượng (v1)

**Project:** La.na Design Storefront  
**Status:** H0 APPROVED 13/10/2026 — R-01..R-05, R-07 và làm tròn đã được owner chốt theo đề xuất, ghi tại [ADR 0016](../decisions/0016-gift-quantity-promotions-v1-decisions.md); **R-06 (POS API acceptance) vẫn mở**; quà gửi Pancake giá 1.000đ/chiếc theo ADR 0016 D-08  
**Ngày:** 13/10/2026  
**Repository baseline tham khảo:** `nguyentuanson27-netizen/la.na_design_storefront`, `main@7371a791af4e`  
**Vị trí dự kiến trong repo:** `docs/specs/gift-quantity-promotions-v1.md`

## 1. Mục tiêu và kết quả mong đợi

Cho phép Admin tạo và vận hành hai loại khuyến mại website-owned:

1. **Tặng sản phẩm (`GIFT_ITEM`)** khi khách đạt ngưỡng **số lượng** hoặc **giá trị hàng trong đơn**; khách tự chọn từ danh sách sản phẩm và biến thể quà hợp lệ.
2. **Giảm giá theo bậc số lượng (`QUANTITY_TIER`)** với các mức giảm %, hoặc số tiền VND cố định **trên mỗi chiếc được giảm**.

Các chương trình có phạm vi sản phẩm/danh mục, thời gian, điều kiện kết hợp và độ ưu tiên do Admin cấu hình. Giá/điều kiện/quà được tính tại server, nhất quán giữa cart → checkout → order snapshot → Pancake. Tính năng không được làm hồi quy các chương trình `PROMOTION`, `FLASH_SALE`, `CLEARANCE` hiện có.

**Người dùng:** Admin cửa hàng (thiết lập và kiểm soát), khách mua hàng (nhận giảm giá/chọn quà), nhân viên vận hành (xem đơn và quà trên Pancake).

**Không thuộc phạm vi v1:** coupon/mã nhập, tích điểm, cá nhân hóa theo tài khoản, quota quà theo khách trọn đời, trình thiết kế luật tùy ý, tự thay quà khi hết hàng, thay đổi chính sách ship, sửa catalog price của Pancake.

## 2. Trạng thái quyết định và giả định minh bạch

**ĐÃ CHỐT QUA INTERVIEW:** FR-01 đến FR-12 bên dưới phản ánh 21 quyết định của chủ cửa hàng; đây là nguồn yêu cầu nghiệp vụ đã xác nhận.

**ĐỀ XUẤT THIẾT KẾ CHỜ CHỦ DỰ ÁN DUYỆT:** chính sách stack/xung đột, ý nghĩa `FIXED_PRICE` legacy, khóa trùng quà theo *sản phẩm gốc*, rounding từng chiếc, gift READY, schema/snapshot và **cách diễn giải FROM nhiều bậc dùng ngưỡng khởi đầu `N0` (R-05)**. FR nào chứa quy tắc đề xuất phải được chủ dự án phê duyệt tại review spec; không suy diễn đây là quyết định thứ 22 của interview. Các quy tắc bảo toàn tiền, bất biến quote và không gửi đơn chưa được xác nhận là safety constraints.

**BẮT BUỘC XÁC MINH TRƯỚC `/build` CHO LUỒNG PHỤ THUỘC POS VÀ TRƯỚC RELEASE:** Pancake có ghi nhận chính xác (1) dòng quà 0đ, (2) `PAID + GIFT` cùng `pancakeVariationId`, (3) **hai dòng `PAID` cùng `pancakeVariationId` nhưng khác đơn giá** hay không. Nếu chưa có bằng chứng live cho luồng cần dùng, chỉ được bắt đầu `/build` luồng đó khi chủ dự án đã phê duyệt phương án thay thế bảo toàn chính xác tiền, số lượng, audit và đã thêm acceptance tests tương ứng. Bằng chứng custom price dương hiện có không chứng minh các trường hợp này.

## 3. Khái niệm và mô hình đếm

- **Sản phẩm gốc:** `ProductMirror`, ví dụ một mẫu đầm hoặc một mẫu set.
- **Biến thể:** `VariantMirror`, ví dụ đầm A/đỏ/M. Biến thể quyết định tồn kho và màu/size, không làm tăng số mẫu sản phẩm gốc.
- **Chiếc hàng mua:** một đơn vị số lượng của dòng hàng khách trả tiền. 1 set được bán như một sản phẩm = 1 chiếc, dù set có nhiều cấu phần vật lý. Không cộng các thành phần cấu thành set thành nhiều chiếc khi tính khuyến mại.
- **Phạm vi hợp lệ (`eligible products`):** hợp của các sản phẩm được chỉ định trực tiếp và thuộc các danh mục được chọn, sau khi trừ danh sách loại trừ; loại trừ luôn thắng. Chỉ dòng **mua trả tiền** mới được tính.
- **Số lượng hợp lệ `Q`:** tổng `quantity` của **tất cả biến thể và tất cả mẫu** nằm trong phạm vi hợp lệ. Có thể cộng đầm A với đầm B và các size/màu khác nhau.
- **Giá trị hợp lệ `S`:** tổng tiền hàng **sau khi áp dụng tất cả giảm giá được phép**, trước phí vận chuyển, không gồm dòng quà. Có thể tính trên toàn đơn hoặc chỉ dòng mua thuộc phạm vi hợp lệ, tùy Admin chọn.
- **Phạm vi toàn đơn (`GLOBAL_ALL_PAID_LINES`):** chỉ dùng với quà `ORDER_SUBTOTAL` + `ALL_PAID_LINES`; lấy tất cả dòng mua trả tiền, không yêu cầu chọn danh mục, sản phẩm, exclude hay chế độ Dynamic/Fixed. Đây là scope logic của trigger, không tự đưa sản phẩm mới vào rule giảm giá.
- **Suất quà:** một quyền chọn một đơn vị quà từ danh sách được cấu hình; không phải tự động thêm quà vào giỏ.
- **Bậc cao nhất:** bậc có `minQuantity` cao nhất không vượt quá `Q`.
- **Ngưỡng khởi đầu `N0` (đề xuất R-05):** ngưỡng số lượng nhỏ nhất trong chương trình tier đã publish. Mức giảm chỉ lấy từ **bậc cao nhất đạt được**; riêng cách đếm chiếc được giảm trong chế độ FROM bắt đầu tại `N0`, không đặt lại từ đầu mỗi khi lên bậc cao hơn.

## 4. Functional requirements — Admin

### FR-01. Tạo và quản lý chương trình

- Admin vào `/admin/promotions`, tạo/sao chép/chỉnh sửa/xem trước/xuất bản/tạm dừng/kết thúc chương trình theo quyền và vòng đời hiện có (`Draft`, `Scheduled`, `Active`, `Ended`, `Disabled`).
- Chọn rõ `GIFT_ITEM` hoặc `QUANTITY_TIER`; không dùng `FIXED_PRICE` cũ để biểu thị giảm VND/chiếc.
- Bắt buộc có tên, loại, thời gian hiệu lực, điều kiện, phần thưởng/giảm giá, cấu hình kết hợp/độ ưu tiên nếu liên quan. **Phạm vi danh mục/sản phẩm chỉ bắt buộc** với trigger số lượng, tier hoặc `ORDER_SUBTOTAL + ELIGIBLE_PAID_LINES`; `ORDER_SUBTOTAL + ALL_PAID_LINES` dùng scope toàn đơn, **không ép Admin chọn danh mục/sản phẩm giả**.
- Chỉ Admin được thay đổi. Các trường không hợp lệ/không dùng cho loại chương trình được từ chối ở server, không chỉ ẩn ở giao diện.
- Xem trước phải có trường hợp đạt/chưa đạt, số quà hoặc số chiếc giảm, tính tiền và cảnh báo xung đột trước khi publish.

### FR-02. Phạm vi sản phẩm và loại trừ

- Admin chọn theo **danh mục**, **sản phẩm gốc cụ thể**, hoặc kết hợp cả hai.
- Admin loại trừ từng sản phẩm gốc; loại trừ có ưu tiên cao hơn mọi quy tắc chọn vào.
- Có hai chế độ trong phạm vi có chọn sản phẩm: `DYNAMIC_CATEGORY` (membership được đọc tại thời điểm tính quyền lợi) và `FIXED_PRODUCT_SET` (**đóng băng danh sách `ProductMirror.id` ngay trong transaction publish**, kể cả khi campaign còn `Scheduled`, không đợi `startsAt`). Resolver hiện tại `SCHEDULED → ACTIVE` chỉ phụ thuộc `now`, **không phát sinh snapshot hoặc DB write tại `startsAt`**.
- Dữ liệu danh mục website-owned hiện có dùng `ProductCategoryMembership.categoryKey`. Cách kế thừa danh mục cha/con cần thống nhất với category resolver hiện hành; không tự sáng tạo quan hệ phân cấp trong khuyến mại.
- **Freeze transaction contract (Scheduled/zero traffic):** cùng transaction publish/re-enable, đọc membership + sản phẩm include/exclude qua một DB snapshot nhất quán (ví dụ transaction isolation phù hợp), tính tập IDs hữu hạn, validate coverage/bounds, persist frozen IDs kèm `frozenAt`/campaign revision và nâng durable `PromotionPricingRevision` theo quy ước hiện hành; tất cả cùng commit hoặc cùng rollback. Category mới sau publish nhưng trước `startsAt` **không** tham gia tập fixed, dù không có request/cron nào chạm chiến dịch. Đổi membership thông thường không được rebuild frozen IDs.
- **Scheduled material edit:** nếu thay đổi category/includes/excludes hoặc `scopeMode` trước khi Active, revalidate và **thay toàn bộ fixed snapshot trong cùng transaction của bản chỉnh sửa**, advance revision; nếu chỉ đổi tên/thời gian/discount/priority, giữ nguyên frozen IDs (chỉ cập nhật cấu hình và revision khi làm thay đổi economic rules). Re-enable campaign Disabled-before-Active được xem là publish mới và **chụp lại** tập fixed từ membership hiện thời; Active/Ended giữ hạn chế mutation/copy theo lifecycle có sẵn. Snapshot phải cho phép audit lý do một sản phẩm có/không tham gia.
- **Scope toàn đơn:** đối với `GIFT_ITEM + ORDER_SUBTOTAL + ALL_PAID_LINES`, Admin không chọn danh mục/includes/excludes/Dynamic/Fixed; server chấp nhận `GLOBAL_ALL_PAID_LINES` và **từ chối tổ hợp scope vừa global vừa có danh sách mục tiêu**. Các rule dùng `QUANTITY`, `QUANTITY_TIER` hoặc `ELIGIBLE_PAID_LINES` vẫn bắt buộc có phạm vi hợp lệ.
- Chương trình chỉ xét sản phẩm/biến thể còn hợp lệ theo trạng thái storefront hiện tại. Thay đổi danh mục/giá/availability phải kích hoạt tái tính quyền lợi trước checkout.

### FR-03. Quà theo số lượng

- Admin chọn `condition = QUANTITY`, `minimumQuantity = N` (số nguyên dương) và danh sách quà.
- Cứ mỗi `N` chiếc hợp lệ, khách có quyền chọn thêm một suất quà: `earned = floor(Q / N)`.
- Nếu Admin đặt `maxGiftsPerOrder`, giới hạn `entitled = min(earned, maxGiftsPerOrder)`; nếu không giới hạn thì `entitled = earned` trong giới hạn kỹ thuật an toàn.
- Ví dụ N=2, Q=6 ⇒ 3 suất; nếu giới hạn 2 thì chỉ 2 suất.

### FR-04. Quà theo giá trị đơn hàng

- Admin chọn `condition = ORDER_SUBTOTAL`, `minimumSubtotalVnd = T > 0`, `subtotalScope = ALL_PAID_LINES | ELIGIBLE_PAID_LINES`.
- Khi `subtotalScope = ALL_PAID_LINES`, server dùng `GLOBAL_ALL_PAID_LINES` và tính `S` từ toàn bộ paid lines dù sản phẩm không nằm trong category nào; không cần/quy định không chấp nhận scope chọn lọc. Khi `subtotalScope = ELIGIBLE_PAID_LINES`, Admin bắt buộc chọn scope category/product và include/exclude có hiệu lực như FR-02.
- Giá trị xét là `S` **sau tất cả giảm giá hợp lệ**; không gồm phí ship và quà.
- Admin chọn `awardMode = ONCE` hoặc `REPEAT_PER_THRESHOLD`:
  - `ONCE`: `earned = 1` nếu `S >= T`, ngược lại 0.
  - `REPEAT_PER_THRESHOLD`: `earned = floor(S / T)`.
- Sau đó áp dụng giới hạn `maxGiftsPerOrder` nếu có.
- Ví dụ T=1.000.000đ, S=2.500.000đ ⇒ 1 suất (`ONCE`) hoặc 2 suất (`REPEAT`).
- Ranh giới đạt ngưỡng là **`>=`**, không dùng dấu `>` của chính sách miễn ship hiện hành.

### FR-05. Danh sách quà và biến thể hợp lệ

- Admin thêm nhiều **sản phẩm gốc** làm lựa chọn quà; đối với mỗi sản phẩm, được chỉ định các `VariantMirror` (màu/size) được tặng.
- Khách tự chọn quà từ các sản phẩm/biến thể Admin cho phép **và còn có khả năng cấp hàng**.
- Admin bật/tắt `allowDuplicateGifts` cho từng chương trình. **Quy ước đề xuất:** nếu tắt, khách chỉ chọn tối đa 1 chiếc thuộc **cùng sản phẩm gốc** trong một chương trình (dù khác variant); nếu bật, có thể chọn nhiều chiếc cùng sản phẩm/variant trong giới hạn quyền lợi và tồn kho.
- Mỗi suất quà chọn đúng một biến thể. Không tự động chọn hoặc thay quà cho khách.
- Chỉ cho chọn số quà `selected <= entitled`; quà không được tham gia điều kiện Q, S, bậc giảm hoặc ngưỡng miễn phí vận chuyển.

### FR-06. Không nhận đủ quà và xác nhận

**Bổ sung đã duyệt (PR #174, implementation PR #175):** [Đặc tả chọn quà và nhắc một lần](storefront-gift-picker-checkout-reminder.md) thay checkbox bằng lời nhắc ở lần submit hợp lệ đầu tiên, rồi chỉ tạo claim cho quote hiện hành khi khách chủ động gửi tiếp. Không gửi đơn khi chỉ đóng popup/chọn chip/quay lại thanh toán; signed acknowledgement và proof phía server giữ nguyên. Nội dung bên dưới mô tả hợp đồng gốc; bổ sung mới có ưu tiên về giao diện và lifetime.

- Khách được chọn từ **0 đến `entitled` suất**; không bắt buộc nhận hết.
- Nếu hàng trong danh sách chỉ còn đủ cấp ít hơn `entitled`, cho phép nhận phần còn lại; nếu hết toàn bộ, cho phép đặt đơn không có quà.
- Trước khi đặt đơn với `selected < entitled`, checkout phải hiển thị **số suất được hưởng / số đã chọn / số bỏ qua hoặc thiếu** và yêu cầu **xác nhận tường minh**. Bao gồm trường hợp khách tự bỏ qua dù còn hàng.
- **Ngoại lệ cho khách chủ động giảm/xóa hàng mua:** sau khi server xác nhận thao tác làm giảm Q hoặc S và số quà đã chọn vượt số suất hiện tại, hệ thống tự bỏ đúng phần quà vượt suất, ưu tiên giữ lựa chọn được lưu sớm nhất. Thông báo số quà bị bỏ ở giỏ hàng hoặc mini-cart; không tự chọn quà khác. Chỉ một mutation hàng mua đã xác nhận mới được kích hoạt cleanup, không suy đoán nguyên nhân từ lượt đọc giỏ.
- Trường hợp Admin đổi quy tắc, hết hàng, catalog thay đổi, xung đột stack hay lỗi DB/quote: **không tự xóa**. Lựa chọn được giữ để khách kiểm tra, và checkout fail-closed nếu lựa chọn không hợp lệ.
- Quyền lợi theo chiến dịch không biến thành phiếu nợ quà giao sau. Order lưu số suất không nhận cùng trạng thái xác nhận.

### FR-07. Giảm giá theo số lượng

- Admin chọn `QUANTITY_TIER`, cấu hình các bậc `(minQuantity, discountValue)` có `minQuantity` là số nguyên dương tăng nghiêm ngặt; **chỉ áp dụng giá trị giảm của bậc cao nhất đạt được**. **Đề xuất để không gây nghịch lý kinh doanh (R-05):** trong cùng chương trình, `discountValue` theo % hoặc VND/chiếc phải **không giảm** khi ngưỡng cao hơn; publish/Scheduled material edit từ chối các bậc giảm giá trị theo cùng đơn vị.
- Admin chọn **một đơn vị giảm giá chung cho toàn chương trình**: `PERCENTAGE` hoặc `FIXED_AMOUNT_PER_UNIT_VND`. Không trộn hai loại trong cùng chương trình.
- Với phần trăm: giảm tỷ lệ trên **giá hiện tại tại bước ưu tiên đó** của từng chiếc được giảm. Với VND: trừ đúng số tiền VND được cấu hình **trên mỗi chiếc được giảm**; không hiểu thành tổng tiền giảm một lần hay giá bán cố định.
- **FIXED_AMOUNT_PER_UNIT_VND invalid price policy:** một bước trừ VND chỉ hợp lệ khi `discountVnd` là số nguyên dương và **`currentUnitPriceVnd - discountVnd >= 1`** trên **mọi chiếc thực sự được giảm** tại bước đó. Không clamp giá về 1đ/0đ, không tạo giá âm, không chuyển thành giảm tổng đơn và không tự bình quân đơn giá. Đây là điều kiện của chính rule mới, không đổi ngữ nghĩa `FIXED_PRICE` legacy.
- **Publish / Scheduled material-edit validation:** server kiểm tra bậc và các biến thể hiện đang bán có thể chịu ảnh hưởng, dùng **giá còn lại sau mọi bước ưu tiên đứng trước được phép stack** (không chỉ catalog base) để từ chối cấu hình chắc chắn gây giá paid ≤0; thông báo variant/ngưỡng/campaign và yêu cầu Admin chỉnh ngưỡng giảm/stack. Không giả định kiểm tra này chứng minh được giá/tồn kho tương lai cho `DYNAMIC_CATEGORY` hoặc thời điểm khác.
- **Runtime / reprice khi dữ liệu đổi:** nếu sau đồng bộ giá, thêm sản phẩm động hoặc thay đổi chương trình đứng trước làm cho tier VND vượt giá còn lại ở **bất kỳ chiếc được giảm nào**, đánh dấu `TIER_PRICE_INVALID` và **không áp dụng toàn bộ tier campaign cho quote đó** (không chỉ bỏ giảm trên chiếc rẻ). Re-resolve **toàn bộ** cart từ giá authority và các campaign còn hợp lệ, tính lại S/quà/ship, hiển thị thay đổi cùng lý do khuyến mại không áp dụng; quote-proof cũ (kể cả khi tổng tiền không đổi) phải bị từ chối và người mua **xác nhận lại báo giá mới** trước khi tạo submit-capable draft/Pancake call. Nếu không tạo được quote hợp lệ hoặc không thể xác thực consent, **chặn checkout**, không gửi POS. Ghi cảnh báo để Admin sửa campaign; tuyệt đối không tự gửi mức giá cao hơn đã được khách đồng ý.
- Admin chọn `discountedUnits = ALL_ELIGIBLE_UNITS | FROM_REACHED_THRESHOLD`.
  - `ALL`: tất cả `Q` chiếc hợp lệ hưởng mức của bậc cao nhất.
  - `FROM_REACHED_THRESHOLD` (**đề xuất cần chủ dự án duyệt R-05**): nếu chương trình có bậc khởi đầu `N0` và `Q >= N0`, giảm **`Q - N0 + 1` chiếc** theo *mức của bậc cao nhất đang đạt*; nếu `Q < N0` thì không giảm. Khi lên bậc mới, **không đặt lại số chiếc được giảm** theo ngưỡng mới. Như vậy `highest tier only` vẫn đúng về **mức giảm**, còn các chiếc từ mốc bắt đầu vẫn được ưu đãi.
- Khi chỉ giảm một phần, Admin chọn `selectionPriority = CHEAPEST_FIRST | MOST_EXPENSIVE_FIRST`.
- **Quy ước đề xuất:** xếp theo **giá của mỗi chiếc ngay trước bước giảm này**, tie-break ổn định theo `pancakeVariationId` rồi khóa định danh dòng, không theo thứ tự browser gửi.
- Ví dụ Q=5, bậc thắng N=3 giảm 10%, `FROM_REACHED_THRESHOLD` ⇒ 3 chiếc được giảm; nếu Q=3 ⇒ 1 chiếc. Khi chọn `ALL` thì đủ Q chiếc được giảm.
- **Phản ví dụ đã loại bỏ bởi cách tính đề xuất:** giá mọi chiếc 500.000đ, các bậc `N=2 → 10%`, `N=4 → 15%`. Công thức cũ `Q - N(winning) + 1` cho Q=3 giảm `2 × 50.000 = 100.000đ`, nhưng Q=4 chỉ giảm `1 × 75.000 = 75.000đ` — mua thêm một chiếc lại mất quyền lợi. Với **`N0=2` cố định**, Q=3 giảm `2 × 50.000 = 100.000đ`, Q=4 giảm `3 × 75.000 = 225.000đ`. Preview phải hiển thị cả số chiếc, mức giảm và tổng tiền giảm trước/sau từng mốc; test chứng minh tổng ưu đãi **của riêng tier này** không giảm khi thêm 1 chiếc với cùng các giá đầu vào và các bậc giảm không giảm. Không bảo đảm tổng tiền cuối đơn bất biến khi giá ngoài chương trình/stack khác thay đổi.
- **Phân bổ giảm theo từng chiếc:** resolver chọn các chiếc đủ điều kiện theo thứ tự ổn định, áp dụng từng bước giảm giá/rounding lên đơn giá của **mỗi chiếc** rồi mới nhóm dòng. Cùng một variant có thể có cả chiếc nguyên giá lẫn chiếc được giảm; không bình quân hay làm tròn lại đơn giá để ép thành một dòng.
- **Tách paid price segments:** chỉ gộp các chiếc đồng nhất về variant, `unitPriceVnd`, discount provenance và fulfillment; mỗi nhóm tạo dòng `PAID` riêng với `lineId` duy nhất trong quote, ổn định khi re-resolve cùng cart/rule facts, do server tạo và **độc lập với `pancakeVariationId`**. Mỗi dòng giữ quantity, đơn giá, thành tiền và discount ledger riêng; `lineId` không chứa cart UUID/PII.
- Ví dụ mua 3 chiếc cùng variant giá 100.001đ, tier N=3 giảm 10% cho chiếc từ mốc: `2 × 100.001đ + 1 × 90.001đ = 290.003đ`. Phải có **hai dòng `PAID`**, quantity 2 và 1, cùng variation ID nhưng khác unit price; không có đơn giá VND nguyên nào cho một dòng quantity=3 tạo được tổng 290.003đ.

### FR-08. Cộng dồn và ưu tiên chương trình

- Admin được cấu hình chương trình **được/không được kết hợp** với chương trình giảm giá và quà khác, bao gồm các loại legacy `PROMOTION`, `FLASH_SALE`, `CLEARANCE`.
- Khi nhiều chương trình giảm giá được phép kết hợp, **áp dụng lần lượt** theo độ ưu tiên Admin thiết lập; mỗi bước nhận **giá còn lại** từ bước trước.
- Ưu tiên có thứ tự rõ ràng, hiển thị trong Admin và bản xem trước; không dựa vào thứ tự DB hoặc request.
- **Đề xuất bảo vệ an toàn:** hai chương trình chỉ stack khi **cả hai** cho phép kết hợp với nhau; thông số loại tương thích và/hoặc các campaign ID được kiểm tra hai chiều. Các chiến dịch không có cấu hình stack vẫn giữ hành vi cũ.
- **Đề xuất:** Admin phải giải quyết trùng độ ưu tiên trong tập chương trình cùng tác động lên một đơn giá trước publish; runtime gặp cấu hình mâu thuẫn phải fail-closed và phát cảnh báo, tuyệt đối không chọn ngẫu nhiên.
- Gift evaluation chạy **sau toàn bộ bước giảm giá**, để điều kiện `ORDER_SUBTOTAL` không tạo vòng lặp với quà.
- Khi nhiều gift campaign được phép cùng chạy, số suất và giới hạn tính **theo từng campaign**, quà của campaign này không dùng để đạt điều kiện campaign khác; tồn kho vật lý cần cộng gộp tất cả nhu cầu.
- **Lên mốc quà cao hơn (không cộng dồn, chỉ áp dụng mốc cao nhất; PR #226):** khi cart hoặc checkout đọc lại trạng thái, quà mốc cũ tự được rút. Chỉ đúng cùng biến thể được chuyển lên mốc cao nếu còn đủ điều kiện, số suất và tồn kho; không tự chọn quà thay thế. Quà đã rút không hồi sinh khi giảm về mốc cũ. Việc giảm giỏ làm mất suất quà do khách chủ động phải theo ngoại lệ FR-06 ở trên, không phải theo việc đọc thụ động. Giữ xử lý xung đột stack và kiểm tra quote/proof dưới cart/campaign lock.

### FR-09. Ngữ nghĩa `FIXED_PRICE` legacy

- `PromotionDiscountType.FIXED_PRICE` của hệ thống hiện tại nghĩa là **giá bán cuối theo chiếc**, không phải trừ đi X đồng. Không được đổi dữ liệu lịch sử/ý nghĩa công thức này.
- **Đề xuất cần duyệt:** trong chuỗi giảm giá có cho phép kết hợp, một chương trình legacy fixed-price đóng vai trò **mức giá trần**: `nextUnitPrice = min(currentUnitPrice, configuredFixedPriceVnd)` để không tăng giá đã được giảm trước đó. Nếu không phù hợp với ý định kinh doanh, phải chọn cách xử lý khác trong review spec; không được tự triển khai cách tính này.
- Giảm % và VND mới là bước giảm thực tế trên `currentUnitPrice`; xử lý VND quá mức **theo fail-closed/requote tại FR-07**, không được làm âm/0đ hoặc âm thầm bỏ bước giảm rồi gửi mức giá mới chưa được khách xác nhận.

### FR-10. Quy tắc tiền VND và tồn kho

- Server là authority cho giá, Q, S, danh tính product/variant, phạm vi, tỷ lệ, ưu tiên, kho và số suất quà.
- Khi một tier bị loại khỏi quote do `TIER_PRICE_INVALID`, phải tính lại các tier/stack downstream trên kết quả mới, quà theo subtotal sau giảm, shipping, quote signature và bất biến đơn; lưu audit reason. Tình huống chạy lại quote phải sử dụng cùng một điểm `now`/scope/price snapshot, không rơi vào vòng lặp giá.
- Sử dụng số nguyên VND an toàn; phép nhân/chia %, cộng dồn cần tránh overflow. **Đề xuất** giữ cách làm tròn half-up bằng `BigInt` đã có trong `promotion-pricing.ts`, ở granularity **mỗi đơn vị hàng** trước khi cộng dòng.
- Đơn giá của hàng mua phải là số nguyên dương; quà tặng có đơn giá thanh toán 0đ **với line role GIFT**. Không cho client giả một dòng mua có giá 0đ.
- Kiểm tra tồn kho quà cùng cơ chế reservation của hàng mua; **cộng nhu cầu vật lý từ tất cả price segments `PAID` và dòng `GIFT` theo cùng `variantId`** trước khi kiểm tra/giữ chỗ. Ví dụ hai dòng `PAID` của một variant với quantity 2+1 chỉ giữ chỗ **3 chiếc vật lý một lần** theo `(orderId, variantId)`, không sinh hai reservation cạnh tranh hoặc giữ chỗ trùng; áp dụng cả khi có `GIFT` cùng variant.
- **Đề xuất để tránh lời hứa tồn kho sai:** quà chỉ chọn từ variant có khả năng giao `READY` được xác minh; hỗ trợ quà composite chỉ khi có kiểm tra/giữ chỗ tài nguyên cấu thành; không mặc định sử dụng quy tắc PREORDER/OVERSELL của hàng mua để cấp quà miễn phí.

### FR-11. Giỏ hàng, checkout và snapshot

**Bổ sung PR #175:** một picker bằng ảnh ngay dưới vùng danh sách trên cart/checkout, độc lập upsell; form được giữ qua lỗi quà và refresh; được bỏ lựa chọn lỗi tại checkout. DTO/identity UI không cấp quyền đặt hàng. Chi tiết và AC-01..AC-28 theo đặc tả bổ sung liên kết tại FR-06.

- Cart và checkout hiển thị rõ điều kiện hiện tại, mức thiếu tới mốc tiếp theo, mức giảm áp dụng, số suất quà đạt được, lựa chọn quà còn hàng và số chưa nhận.
- Khách chọn quà trong UI riêng, các quà **không** tự thêm thành `CartItem` trả tiền. Khi lượng mua giảm hoặc campaign hết hạn, quyền lợi được tính lại và lựa chọn không hợp lệ phải được hiển thị/đề nghị chọn lại.
- Quote gồm dòng **`PAID`** (có thể nhiều dòng cùng variation ID với giá khác nhau) và **`GIFT`**, mỗi dòng có **`lineId` duy nhất**, do server dựng/canonicalize ổn định giữa render và submit nếu facts không đổi, không dùng variation ID làm khóa dòng. Mỗi dòng có role, variation ID, quantity, `unitPriceVnd`, `lineTotalVnd`, fulfillment, campaign ID/version và ordered discount provenance; quote cũng ghi entitlement, selection và acknowledgment. `lineId` không để lộ cart UUID/PII và không do browser quyết định.
- Quote proof ký/xác minh **từng `lineId`, role, variation ID, quantity, đơn giá, thành tiền và discount steps** của cả `PAID` và `GIFT`, quyền lợi quà và xác nhận từ bỏ quà; không chỉ ký tổng tiền. Canonical quote cho phép variation ID lặp khi `lineId` khác nhau, không làm mất giá/discount provenance. Nếu giá, phân bổ paid, điều kiện, quà, tồn kho/cấp quà hoặc fulfillment thay đổi, submit yêu cầu xác nhận lại — **kể cả khi tổng tiền không đổi**.
- Lưu order snapshot bất biến **theo `lineId`** về role `PAID/GIFT`, variation ID, quantity, đơn giá, thành tiền, campaign/rule/version, discount-step provenance, quà/entitlement và xác nhận. Hai dòng `PAID` của cùng variant khác giá phải được lưu riêng; tổng các `lineTotalVnd` paid phải bằng merchandise subtotal đã xác nhận. Retry phải idempotent và không tự cấp lại quà.
- Với shipping: chỉ dùng **số chiếc hàng mua trả tiền** và **subtotal trả tiền sau giảm**; quà không đẩy đơn qua ngưỡng miễn ship. **Không thay đổi** điều kiện hiện tại `subtotal > ngưỡng` hoặc `paid quantity >= ngưỡng`.

### FR-12. Pancake, analytics, feed và SEO

- Website sở hữu chính sách khuyến mại; Pancake tiếp tục sở hữu catalog, base price và nguồn sự thật tồn kho. Không sửa giá danh mục Pancake chỉ vì có promotion.
- Adapter Pancake phải bảo toàn **từng dòng `PAID`** (có thể lặp `pancakeVariationId` với đơn giá khác nhau), từng dòng quà `GIFT` 0đ nếu POS chấp nhận, quantity và giá cuối mỗi dòng. `lineId` là danh tính nội bộ quote/snapshot, không giả định Pancake hỗ trợ field đó. Hậu kiểm read-back từng mức giá, quantity, tổng tiền và order ID; **không** bình quân, thay giá hoặc gộp dòng chỉ để né trùng variation ID.
- **Pre-build contract decision / release blocker:** operator phải kiểm chứng có kiểm soát (1) quà 0đ, (2) `PAID+GIFT` cùng variation và (3) **`PAID+PAID` cùng variation nhưng khác giá**, cùng tính nhất quán read-back/reconcile/cancel/retry/stock và tổng tiền. Nếu trường hợp cần dùng không được chứng minh live, **trước `/build` luồng phụ thuộc POS đó** phải có phương án thay thế bảo toàn money/stock/audit và được chủ dự án phê duyệt. Không có bằng chứng hay phương án phù hợp thì giữ **OFF** chức năng gift hoặc tier `FROM_REACHED_THRESHOLD` liên quan; không âm thầm bình quân/làm tròn đơn giá.
- Analytics/Meta Purchase sử dụng doanh thu thực trả, không tính quà 0đ thành doanh thu; order audit lưu danh tính quà. Merchant feed, canonical price trên PDP và structured data không được công bố mức giảm theo giỏ như giá mua đơn chiếc vô điều kiện.

## 5. Thuật toán tham chiếu (hợp đồng hành vi, chưa phải code)

1. Đọc giỏ hàng trả tiền, catalog/variant/selling mode, category membership, cấu hình chiến dịch và `now` trong một lần tính nhất quán.
2. Xác định campaign hiệu lực và product scope: `GLOBAL_ALL_PAID_LINES` không cần category picker; `FIXED_PRODUCT_SET` chỉ dùng frozen IDs đã ghi tại publish/Scheduled scope-edit; `DYNAMIC_CATEGORY` đọc membership hiện tại. Giải quyết tính tương thích/ưu tiên stack; nếu conflict không hợp lệ thì từ chối giá mâu thuẫn theo chính sách fail-closed.
3. Tính **giá trả tiền** lần lượt theo priority, cả legacy và tier; Q từ số chiếc paid mua thật trước khi split. Chọn bậc **cao nhất đạt được**, còn phạm vi FROM được tính từ **`N0` là bậc đầu tiên** (R-05, chờ owner duyệt), không đặt lại theo bậc thắng; xếp CHEAPEST/MOST_EXPENSIVE, phân bổ giá từng chiếc và tạo `PAID` price segments với `lineId`. Nếu tier VND không đảm bảo đơn giá paid >=1 tại bất kỳ chiếc đang được giảm, loại **toàn bộ** tier khỏi quote, tính lại authority và trả trạng thái `TIER_PRICE_INVALID`, không clamp giá.
4. Tính subtotal hàng mua và `S` của từng gift campaign **sau hoàn tất giảm giá**; tính entitled bằng công thức tại FR-03/04 và giới hạn trên mỗi đơn.
5. Lấy danh sách biến thể quà còn được phép và khả dụng; xác nhận lựa chọn người mua, chống chọn trùng khi tắt, và tổng nhu cầu kho kể cả paid + gift.
6. Tính shipping từ tổng quantity và subtotal của các dòng `PAID`, không gồm `GIFT`. Quote ký từng `lineId`, role, đơn giá/quantity/thành tiền của paid price segments, discount ledger, quyền lợi và xác nhận không nhận quà; nhiều paid lines trùng variation nhưng khác giá không bị gộp.
7. Khi submit, re-resolve giá, scope, campaign, kho và quote **trong transaction/critical section hiện có**; so sánh toàn bộ với bằng chứng người mua đã chấp nhận. Nếu khác, trả quote mới yêu cầu xác nhận; chưa submit Pancake.
8. Giữ chỗ hàng và quà nhất quán; ghi snapshot; submit Pancake bằng duy nhất một order idempotency boundary; reconcile success/unknown/error theo chính sách hiện tại.

### Ví dụ bắt buộc

| ID | Cấu hình và giỏ | Kết quả yêu cầu |
|---|---|---|
| EX-01 | QUANTITY gift N=2, Q=1/2/4/6 | 0/1/2/3 suất tương ứng |
| EX-02 | N=2, Q=10, maxGiftsPerOrder=3 | 3 suất, không phải 5 |
| EX-03 | ORDER_SUBTOTAL T=1.000.000đ, `S=999.999đ` / `S=1.000.000đ` | 0/1 suất (ONCE) |
| EX-04 | T=1.000.000đ, S=2.500.000đ | ONCE=1; REPEAT=2 |
| EX-05 | Đầm 600k + phụ kiện 500k sau giảm; eligible là Đầm; T=1m | ALL_PAID=đạt; ELIGIBLE_PAID=không đạt |
| EX-06 | Q=3: 1 đầm A/S + 1 đầm A/M + 1 đầm B/L | Đếm 3 chiếc nếu nằm trong phạm vi; 1 set = 1 chiếc |
| EX-07 | Tier N=3, Q=5, giảm 10% | ALL giảm 5 chiếc; FROM_REACHED_THRESHOLD giảm 3 chiếc |
| EX-08 | Tier N=3, Q=3, giá 400k/600k/800k | FROM + CHEAPEST giảm trên 400k; FROM + MOST_EXPENSIVE giảm trên 800k |
| EX-09 | Giá 1m, cho stack Flash 10% trước Tier 5% | Giá còn 855.000đ |
| EX-10 | S trước giảm 1,2m; sau giảm 960k; gift T=1m | Không được quà |
| EX-11 | Earned=3; tồn quà chỉ cấp được 1; khách chọn 1 và xác nhận thiếu 2 | Có thể checkout với 1 quà, snapshot ghi 2 chưa nhận |
| EX-12 | Earned=2; quà còn hàng nhưng khách không chọn; xác nhận bỏ qua | Checkout được với 0 quà, có bằng chứng xác nhận |
| EX-13 | Quà same variant với hàng mua | Quote tách paid/gift; reservation gộp số vật lý; POS contract phải được xác minh |
| EX-14 | Thay lựa chọn quà A→B, tổng tiền không đổi | Quote proof cũ không còn hợp lệ; yêu cầu khách xem/xác nhận lại |
| EX-15 | Gift Q=2 được chọn từ mẫu có đỏ/M, đen/S; đỏ/L không được Admin cho | Chỉ đỏ/M và đen/S là lựa chọn hợp lệ |
| EX-16 | Dynamic category có sản phẩm mới; Fixed set có sản phẩm mới | Dynamic tự xét khi hợp lệ; Fixed không tự thêm |
| EX-17 | Một variant, 3 chiếc × 100.001đ, tier N=3 giảm 10% `FROM` | Tạo hai dòng `PAID` cùng variation: (`lineId=A`, quantity=2, unit=100.001đ) + (`lineId=B`, quantity=1, unit=90.001đ) = **290.003đ**; quote proof/snapshot giữ đủ 2 line IDs, không được bình quân giá |
| EX-18 | EX-17, cần giữ chỗ tồn kho cho hai dòng paid | Capacity/reservation cộng đúng **3 chiếc vật lý** cùng variant, giữ chỗ một lần theo `(orderId, variantId)`; submit POS phụ thuộc acceptance paid+paid khác giá hoặc phương án thay thế được duyệt |
| EX-19 | 500.000đ/chiếc, tier N=2 giảm 10%, N=4 giảm 15%, FROM, chỉ có một loại hàng giá không đổi | **Công thức cũ Q−N(winning)+1**: Q=3 tiết kiệm 100.000đ, Q=4 chỉ 75.000đ (không chấp nhận). **Đề xuất N0=2**: Q=3 tiết kiệm 2×50.000=100.000đ; Q=4 tiết kiệm 3×75.000=225.000đ, chỉ dùng mức 15% của bậc cao nhất; preview và test ranh giới |
| EX-20 | Scheduled fixed campaign publish lúc T0 có đầm A/B; T1 thêm đầm C vào category, T2=startsAt; không có request trước T2 | Snapshot fixed A/B ngay tại T0; T2 vẫn chỉ A/B; Scheduled sửa scope trước T2 tái snapshot trong transaction, sửa chỉ tên/time giữ A/B; re-enable Disabled-before-Active chụp lại theo membership mới |
| EX-21 | Tier giảm cố định 50.000đ/chiếc; giá hiện tại sau Flash trước tier chỉ còn 40.000đ | Publish/Scheduled edit reject nếu biết trước; nếu phát sinh sau sync/reprice, bỏ **toàn tier campaign** khỏi quote đó, re-resolve/quà/ship; yêu cầu buyer xác nhận quote mới, không clamp về 1đ hay tự submit POS |
| EX-22 | Gift ORDER_SUBTOTAL T=1.000.000đ, ALL_PAID_LINES, không chọn category/products; giỏ có đầm 600k + phụ kiện 500k | Scope `GLOBAL_ALL_PAID_LINES`, S=1.100.000đ, nhận quyền chọn quà; Admin không bị bắt chọn category; chọn global + include/exclude bị từ chối |

## 6. UI/UX và phân quyền

### Admin `/admin/promotions`

- Chọn loại chương trình; form biến đổi theo loại, không hiển thị trường mâu thuẫn.
- Scope picker có danh mục, sản phẩm bổ sung, loại trừ, Dynamic/Fixed, đếm/preview; **ẩn và không yêu cầu** danh mục/product khi chọn `ORDER_SUBTOTAL + ALL_PAID_LINES` (hiển thị rõ **Áp dụng giá trị toàn đơn**). Khi `FIXED_PRODUCT_SET`, preview cho biết danh sách **đã chốt tại publish** và thời điểm `frozenAt`, không hứa thu nạp sản phẩm mới sau đó.
- Gift form có QUANTITY/ORDER_SUBTOTAL; ngưỡng, subtotal scope; `ALL_PAID_LINES` chạy được với scope trống, `ELIGIBLE_PAID_LINES` đòi scope; ONCE/REPEAT (chỉ ở value), max gift optional, quà theo product/variants và allow duplicate.
- Tier form có danh sách bậc, loại giảm %, VND mỗi chiếc; ALL/FROM; CHEAPEST/MOST_EXPENSIVE chỉ khi FROM.
- Tier preview cần minh họa **Q ngay trước/sau mỗi bậc**, số chiếc giảm theo `N0`, tổng mức giảm và so sánh khi tăng Q với cùng giá; highlight phản ví dụ Q=3→4 của EX-19. Khi bậc giảm giá trị hoặc VND gây paid <=0 theo giả định giá hiện có, chặn publish với lỗi cụ thể.
- Stacking editor hiển thị luật tương thích, priority, cảnh báo conflict, và preview giá minh họa. Trạng thái publish phải từ chối input mâu thuẫn/bậc không tăng/ngưỡng không hợp lệ.
- Mọi thay đổi có audit tối thiểu: actor, campaign ID, bản trước/sau hoặc revision, thời điểm, hành động; tránh lưu dữ liệu cá nhân khách.

### Storefront/Cart/Checkout

- Bảng thông tin khuyến mại cho biết phạm vi/điều kiện thực tế; không gắn nhãn “giá đã giảm” vô điều kiện khi chưa đủ số lượng.
- Khi đạt gift campaign, mở vùng chọn quà theo sản phẩm → màu/size; trạng thái hết hàng/giới hạn lặp và số suất còn lại rõ ràng. Nếu Q hoặc S thay đổi, entitlement thay đổi tương ứng.
- Checkout có dòng quà giá 0đ, tổng discount, tiền hàng phải trả, shipping, quyền lợi chưa nhận, hành động xác nhận bỏ quà. Không cho submit nếu thiếu acknowledgment khi `selected < entitled`.
- Đơn hoàn tất và backoffice phân biệt `PAID` và `GIFT` và ghi đúng provenance khuyến mại, không cộng quà 0đ vào revenue.
- Tiêu chí accessibility: label/keyboard/focus/error/status live region; mobile layout; chọn quà không phụ thuộc chỉ vào màu sắc.

## 7. Thiết kế dữ liệu và tích hợp dự kiến

### Repository hiện tại đã đối chiếu

- Next.js `16.3.3`, React `19.2.0`, TypeScript, Prisma `7.9.1`, PostgreSQL, Better Auth; `pnpm@11.4.0`, Node `>=22.14.0`.
- `prisma/schema.prisma`: `PromotionCampaign` hiện yêu cầu discountType legacy, `PromotionTarget`, `PromotionPricingRevision`, `ProductMirror`, `VariantMirror`, `ProductCategoryMembership`, `CartItem @@unique([cartId, variantId])`, `OrderMirror`, `OrderLineSnapshot`.
- `src/commerce/promotion-pricing.ts`: chỉ nhận tối đa một legacy campaign trên variant; xung đột hiện trả về base price, không stack; `%` làm tròn half-up bằng BigInt; `FIXED_PRICE` là giá cuối.
- `src/commerce/checkout-quote.ts`: không chấp nhận đơn giá paid <=0 hoặc trùng variation ID; `checkout-quote-proof.ts` xác minh bằng MAC với distinct variation IDs.
- `src/commerce/guest-checkout-snapshot.ts`, `src/commerce/pancake-order-submit.ts`: hiện dựa vào các dòng paid per-variant, reservation, price reconfirmation và snapshot; phải thay đổi đồng bộ chứ không chỉ ở UI.
- `src/commerce/guest-shipping-policy.ts`: hiện miễn ship khi `subtotal > threshold` **hoặc** `paid quantity >= threshold`.
- `src/integrations/pancake/order-create.ts`: payload cho phép integer `unitPriceVnd >= 0`; điều đó **không chứng minh** Pancake server nhận line 0đ. `docs/integrations/pancake-p10-custom-price-acceptance.md` mới chứng minh case giá tùy chỉnh dương.

### Data contract đề xuất (không phải migration đã viết)

- **Campaign**: `id`, `kind`, `name`, effective window, lifecycle, `priority`, `version/revision`, stacking policy, creator/audit.
- **Eligibility scope**: discriminated union `GLOBAL_ALL_PAID_LINES` (không category/targets, dành riêng gift `ORDER_SUBTOTAL+ALL_PAID_LINES`) **hoặc** `DYNAMIC_CATEGORY` (category keys + includes/excludes) **hoặc** `FIXED_PRODUCT_SET` (frozen ProductMirror IDs, `frozenAt`, campaign revision, nguồn category/includes/excludes để audit). Snapshot fixed được ghi trong cùng publish/re-enable/Scheduled scope-edit transaction, có DB snapshot nhất quán, không thêm vào lúc start và không phụ thuộc lưu lượng. Không sửa catalog membership.
- **Gift rule**: `trigger: QUANTITY | ORDER_SUBTOTAL`, minimum, subtotal scope, repeat mode, max gifts, `allowDuplicateGifts`, product/variant gift allowlist.
- **Tier rule**: discount unit, ngưỡng `minQuantity` tăng nghiêm ngặt, `discountValue` cùng loại **không giảm**, ALL/FROM, CHEAPEST/MOST_EXPENSIVE và `N0` (min threshold) để tính số chiếc FROM; validation bao gồm VND vượt current paid unit sau stacking, audit `TIER_PRICE_INVALID` và cơ chế re-quote.
- **Cart gift selection**: cart/campaign/variant/qty, validated server-side; tách khỏi paid `CartItem`. Thay đổi selection làm vô hiệu proof trước đó.
- **Resolved quote lines**: `lineId` duy nhất / role / campaign trên facts canonical do server tạo, **không unique theo variation ID**; một variant có thể sinh nhiều price segments `PAID` ngay cả khi không có gift. Mỗi line giữ nguyên quantity × `unitPriceVnd` = `lineTotalVnd`; quote lưu các discount steps và trạng thái bất hợp lệ như `TIER_PRICE_INVALID`, paid/gift, entitlement, acknowledgment và campaign version để thay đổi provenance cũng làm mất hiệu lực proof.
- **Order snapshots**: `lineId`, `PAID/GIFT` role, variation ID, quantity/đơn giá/thành tiền theo từng price segment; discount step ledger (`campaignId`, priority, type, input/output price, applied qty); gift entitlement/selected/unclaimed và proof acknowledgment. Giữ hai dòng PAID cùng variant có giá khác nhau tách biệt, bất biến khi finalized, không phá dữ liệu lịch sử.
- **Pancake map**: tách semantic website lines khỏi shape vendor; adapter dùng contract đã xác minh, không tự suy ra từ typescript type.

**Định hướng kiến trúc:** engine khuyến mại **cấp giỏ hàng thuần/pure** sau một nguồn giá paid thống nhất; giữ lại legacy price resolver khi feature gate tắt. Tránh nhồi gift vào `promotion-pricing.ts` như một giá variant vô điều kiện hoặc sửa `CartItem` paid thành dòng quà. Schema có thể dùng bảng campaign riêng để tránh khiến `PromotionCampaign.discountType` hiện có vô nghĩa; quyết định chi tiết ở `/plan` sau khi review migration/backward compatibility.

## 8. Security, correctness và concurrency

- Tất cả mutation Admin qua server authz hiện có (`requireCurrentAdmin`), validate enum allowlist, số nguyên/BigInt, giới hạn dòng, ngày, variant tồn tại và campaign state. Không tin vào campaignId/price/eligibility do browser cung cấp.
- Gift choice chỉ được lưu/đặt đơn cho **cart chủ thể hợp lệ**, thuộc campaign active, gift variant allowlisted và inventory hiện đủ; giới hạn số lượng quà, cap, duplicate policy đều kiểm tra ở server.
- Quote token ký trên facts canonical, context cart, thời điểm/phiên bản và toàn bộ gift selections. Hết hạn/vô hiệu khi bất kỳ giá hoặc quyền lợi thay đổi; không lộ cart UUID/secret/PII trong payload.
- Tính và giữ chỗ tồn kho paid + gift bằng một critical section bảo vệ race và retry; idempotency theo order, không giữ chỗ lần thứ hai khi cùng request được retry. Nếu không thể xác nhận an toàn, **không gửi đơn tới Pancake**.
- Nếu POS trả unknown sau submit, bảo lưu trạng thái/hàng giữ chỗ và reconcile thay vì tạo đơn mới tự động; gift không được cấp trùng.
- Biến thể gift composite phải trừ tài nguyên cấu thành như composite paid nếu được hỗ trợ; không suy tồn kho chỉ từ số lượng parent.
- Giới hạn cấu hình (số bậc, gift variants, targets, suất quà, độ dài name, token size, số dòng quote) theo bounded input để tránh chi phí tính giá và payload tăng không kiểm soát. Giá/discount không được âm, Infinity, NaN hay overflow; paid price không được 0đ.
- Không ghi PII/token/secrets trong telemetry; không lộ lý do nội bộ trong response public.

## 9. Testing strategy và ma trận chấp nhận

**Domain/unit:**
- Form parse + lifecycle + quyền Admin; scope include/exclude; category Dynamic/Fixed; **fixed snapshot tại publish transaction, không phụ thuộc Scheduled start traffic, Scheduled scope-edit replace nhưng non-scope edit giữ snapshot, re-enable recapture**; global all-paid scope không targets và từ chối global cùng selected scope; parent set và mọi màu/size.
- Gift Q=N−1/N/2N/2N+1, limit; value S=T−1/T/2T+1, ONCE/REPEAT, subtotal ALL/ELIGIBLE, trừ shipping/quà.
- Tier highest-only, %, fixed-VND-per-unit, ALL/FROM từ **N0**, cheapest/expensive, tie deterministic, round half-up, money boundary, validate values không giảm; **EX-19** phát hiện & loại bỏ nonmonotonic total discount khi Q=3→4. **EX-17** bảo toàn 290.003đ, hai line IDs ổn định. **EX-21** invalid VND sau stacking/sync: reject khi publish nếu biết, runtime drop toàn tier+requote, không clamp, không POS khi proof stale.
- Stacking pairwise permission/priority, legacy fixed price, overlap/concurrent mutation/conflict fail-closed, gift evaluated after discounts.
- Duplicate gift product and variant policy; selection partial/zero, invalid selection, camp expired, different gift same total.

**DB/integration:**
- Migration backcompat và revision bump transactional; **frozen scope + frozenAt + campaign revision cùng publish/re-enable/scope-edit transaction** có nhất quán khi membership thay đổi đồng thời; trạng thái Scheduled chuyển theo clock không làm DB mutation. Immutable per-`lineId` order audit; concurrent reservations gộp paid/gift đúng một lần; retry không trùng.
- Signed quote với từng paid price segment, gifts/ack và status `TIER_PRICE_INVALID`: thay campaign price/quote giá lên hoặc không đổi vẫn buộc buyer re-confirm, không tạo submit-capable draft/Pancake khi stale; EX-17 giữ hai line IDs, EX-21 reprice stock/category/rule/discount theo thứ tự. Signature bảo toàn toàn bộ facts.
- Pancake live acceptance có kiểm soát cho **GIFT 0đ**, **PAID+GIFT cùng variation** và **PAID+PAID cùng variation khác đơn giá** (EX-17); kiểm tra read-back line-level money/quantity/total, rollback/cancel/reconcile/unknown. Nếu POS không hỗ trợ, yêu cầu phương án thay thế được chủ dự án duyệt trước `/build`. Không chạy acceptance có side effects trong CI.
- Existing promotion, shipping, product catalog, Merchant/Meta Purchase, preorder/composite regressions.

**Browser/E2E và accessibility:**
- Admin tạo gift theo Q và S: **ALL_PAID_LINES không cần scope** và ELIGIBLE scope bắt buộc, ONCE/REPEAT, duplicate cap, allowed variants; tạo tier % và VND, preview `N0`, báo lỗi giá âm/0, EX-19 so sánh Q=3/4 và EX-21 checkout re-confirm.
- Cart 1 đầm + 1 set, nhiều size cùng mẫu, chọn 2 quà khác nhau/trùng khi được phép; vượt/mất ngưỡng.
- Khách bỏ 1/all gifts, partial stock, out of stock, giao diện xác nhận; đổi quà khiến quote mất hiệu lực.
- Keyboard/focus/labels/announcement, mobile/cart/checkout; EX-20 Scheduled fixed scope không tự thêm sản phẩm mới giữa publish→startsAt và Scheduled scope edit re-freeze, EX-22 global all-paid; test thời điểm bắt đầu/kết thúc, không dựa vào cron.

**Các file test hiện có để mở rộng:** `tests/domain/promotion-pricing.test.ts`, `tests/domain/checkout-quote.test.ts`, `tests/domain/checkout-quote-proof.test.ts`, `tests/domain/guest-shipping-policy.test.ts`, `tests/database/promotion-persistence.test.ts`, `tests/database/guest-checkout-p9a-quote-proof.test.ts`, `tests/database/capacity-reservation.test.ts`, `tests/database/pancake-order-submit.test.ts`, `tests/a11y-runtime/admin-promotions.spec.ts`, `tests/a11y-runtime/checkout.spec.ts`.

**Commands khi bắt đầu triển khai (chưa chạy trong lượt viết spec):**

```bash
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm exec playwright test --config playwright.config.ts
pnpm build
pnpm release:check
```

CI/PostgreSQL/browser và integration live secrets phải được cung cấp theo môi trường kiểm thử hợp lệ; kiểm tra Pancake live cần phê duyệt riêng.

## 10. Rollout, kiểm soát vận hành, ranh giới

- Mở rộng bằng migration cộng thêm, rollback tương thích; **feature flag mặc định OFF** cho khuyến mại mới. Không sửa dữ liệu lịch sử, không tự bật campaign hiện có.
- Stage rollout: **trước `/build` của luồng phụ thuộc POS**, xác nhận contract cho từng case (quà 0đ, `PAID+GIFT`, `PAID+PAID` hai giá) bằng bằng chứng live hoặc phương án thay thế được chủ dự án duyệt → domain/DB tests → admin preview/sandbox → quote/order integration → controlled end-to-end Pancake acceptance/read-back trên adapter triển khai → E2E/accessibility → owner review → bật có kiểm soát. Kill switch phải dừng tạo quote mới theo luật mới mà không làm sai các order đã hoàn tất.
- Metrics/log không PII: promotion candidate/conflict, quote/requote, gift entitled/selected/unclaimed, stock insufficiency, stale proof, price divergence, Pancake accepted/rejected/unknown, idempotency dedupe. Alert cho xung đột active, tồn kho âm/quà trùng, POS quote mismatch.
- **Always:** giữ chuẩn authz, validation, integer money, atomic reservation, proof, migrations, tests, docs, feature gating và Definition of Done trong `05_SHARED_REFERENCES.md`.
- **Ask first:** thay đổi semantics legacy `FIXED_PRICE`, cấu trúc tables khi dữ liệu thật có migration rủi ro, trường hợp adapter Pancake cần compromise, thêm dependencies, điều chỉnh ship/SEO/analytics, đổi behavior legacy overlap.
- **Never:** đổi giá catalog của Pancake, tin giá/quà từ browser, xuất order/POS lệch quote, tự bỏ quà không xác nhận, ship tính quà như paid, sửa lịch sử đơn, báo đã được Pancake hỗ trợ 0đ khi chưa thử.

## 11. Acceptance criteria tổng hợp (definition of success)

- [ ] AC-01 Admin tạo được `GIFT_ITEM` với QUANTITY hoặc ORDER_SUBTOTAL, ALL/ELIGIBLE subtotal và ONCE/REPEAT; **ALL_PAID_LINES chạy không cần danh mục/product scope** còn ELIGIBLE cần scope; từ chối tổ hợp global+targets.
- [ ] AC-02 Admin cấu hình Dynamic/Fixed scope category + product includes/excludes; fixed IDs snapshot **trong publish/re-enable hoặc Scheduled scope-edit transaction** (zero traffic/startsAt không thay đổi), non-scope edit giữ snapshot; số chiếc gộp các mẫu/variants và set đếm 1.
- [ ] AC-03 Admin quản lý được danh sách quà product + allowed variants, cho/không cho trùng và max gifts/đơn tùy chọn.
- [ ] AC-04 Earned/selected gift slots luôn đúng tại ranh giới; khách chọn được 0..entitled, kể cả khi kho thiếu một phần/toàn bộ, với xác nhận bắt buộc nếu không nhận đủ.
- [ ] AC-05 Highest-tier-only; tier discount values cùng loại **không giảm**; ALL/FROM tính từ `N0` để tránh mất tổng ưu đãi khi lên bậc (EX-19, chờ owner duyệt R-05), CHEAPEST/MOST_EXPENSIVE đúng; nhiều `PAID` khác giá cùng variation bảo toàn 290.003đ của EX-17.
- [ ] AC-06 Stack theo priority, tính từ giá còn lại, không tạo paid price <=0; VND không hợp lệ được **reject publish nếu biết trước** hoặc **loại toàn tier+requote+re-ack** ở runtime (EX-21), tuyệt đối không clamp hoặc gửi giá cao hơn quote đã ký; telemetry phản ánh lỗi.
- [ ] AC-07 Ngưỡng giá trị quà xét tiền sau tất cả giảm giá, trước phí ship và không tính quà; giá ở mọi bề mặt cùng một authority.
- [ ] AC-08 Quote proof ký/xác thực từng `lineId`, role, quantity, đơn giá và discount step của paid/gift; nhiều paid lines cùng variation khác giá không bị mất; bất kỳ thay đổi dù tổng tiền bằng nhau cũng cần re-confirm.
- [ ] AC-09 Reservation và submit idempotent; các price segments `PAID` và `GIFT` cùng variant được gộp nhu cầu vật lý, EX-18 chỉ giữ chỗ đúng 3 chiếc một lần; composite và concurrency không cấp/giữ chỗ trùng.
- [ ] AC-10 Pancake live acceptance cho quà 0đ, `PAID+GIFT` cùng variation và **`PAID+PAID` cùng variation khác đơn giá**, hoặc phương án thay thế được chủ dự án duyệt trước `/build` luồng phụ thuộc; chưa có bằng chứng/giải pháp thì gate liên quan vẫn OFF.
- [ ] AC-11 Order snapshot/audit bất biến, shipping/analytics/feeds/preorder/legacy promotion không bị hồi quy.
- [ ] AC-12 Domain/DB/E2E/accessibility/security/observability/release gates và Definition of Done đạt, có evidence và rollback.

## 12. Các điểm cần review trước khi chốt spec/plan

**R-01 — Cách ghép cặp stack:** đề xuất opt-in hai chiều, cấu hình tương thích theo loại/chương trình và unique priority, giữ fail-closed với overlap legacy. Cần xác nhận đây là quy ước mong muốn trước implementation.

**R-02 — Legacy FIXED_PRICE:** đề xuất dùng giá trần trong thứ tự giảm, không phải discount VND; không tự đổi semantics cũ.

**R-03 — Trùng quà:** đề xuất cấm trùng theo `ProductMirror` khi toggle OFF, thay vì chỉ theo màu/size `VariantMirror`.

**R-04 — Gift fulfillment:** đề xuất chỉ cấp quà READY và đã chứng minh capacity, bao gồm composite nếu hỗ trợ; không tự dùng PREORDER/OVERSELL cho quà.

**R-05 — Cách diễn giải `FROM_REACHED_THRESHOLD` khi nhiều bậc — PHƯƠNG ÁN ĐỀ XUẤT CHỜ OWNER DUYỆT:** dùng `N0 = min(minQuantity)` làm mốc chiếc bắt đầu giảm cho toàn bộ chương trình, `discountValue` ở bậc **cao nhất** đang đạt áp lên `Q-N0+1` chiếc; giá trị giảm theo bậc không được giảm. Cách cũ `Q-N(winning)+1` bị loại trong **bản đề xuất** vì có thể làm tổng ưu đãi giảm khi Q tăng (EX-19: 100.000đ → 75.000đ); đề xuất mới Q=3 100.000đ → Q=4 225.000đ. Đây **không phải quy tắc người dùng đã chốt trong interview**; chủ dự án phải xác nhận tại review spec trước `/plan`/`/build` phần tier.

**R-06 — POS acceptance (hard blocker):** kiểm chứng live có operator phê duyệt cho (a) quà giá 0đ, (b) PAID+GIFT trùng variation, (c) **PAID+PAID trùng variation với giá khác nhau**; read-back unit/quantity/totals, cancel/reconcile, rollback an toàn. Nếu (c) không đạt, trước `/build` phải có phương án thay thế được chủ dự án duyệt, giữ chính xác 290.003đ của EX-17; không bình quân/làm tròn giá. Các gate (a)/(b) vẫn độc lập.

**R-07 — Phân cấp category:** xác minh category scope cha/con và snapshot fixed theo category resolver site-owned đang dùng, tránh tính sản phẩm ngoài danh mục Admin nghĩ mình đã chọn.

**Cập nhật H0 (13/10/2026):** R-01, R-02, R-03, R-04, R-05 (`N0`), R-07 và làm tròn half-up BigInt trên đơn giá từng chiếc đã được owner chấp thuận đúng như đề xuất — xem ADR 0016. **D-08:** khi gửi Pancake, mỗi chiếc quà có giá **1.000đ** và tổng số đồng này (1.000đ × số chiếc quà) được trừ khỏi các chiếc hàng mua (đơn Pancake bằng tổng website); quote/proof/snapshot/analytics của website vẫn ghi quà 0đ. R-06 còn mở ở mức API cho (b) PAID+GIFT cùng variation và (c) PAID+PAID khác giá; case (a) quà 0đ không còn cần cho luồng.

**Trạng thái trước H0 (lịch sử):** 4 self-review findings về fixed snapshot, VND overflow, FROM multi-tier và global scope đã được xử lý **trong bản đề xuất spec** với examples/AC. **R-05 vẫn yêu cầu chủ dự án xác nhận cách tính `N0`**, cùng các quyết định R-01..R-04/R-07 và gate Pancake R-06; chưa `/plan`, chưa `/build`, chưa migration/code change hoặc live POS acceptance.
