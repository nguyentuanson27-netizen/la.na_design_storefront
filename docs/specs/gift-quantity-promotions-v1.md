# SPEC-PRM-002 — Khuyến mại tặng sản phẩm và giảm giá theo số lượng (v1)

**Project:** La.na Design Storefront  
**Status:** DRAFT — đã xác nhận yêu cầu interview; chờ chủ dự án duyệt spec trước `/plan` và `/build`  
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

**ĐỀ XUẤT THIẾT KẾ CHỜ REVIEW SPEC:** chính sách xung đột cặp chương trình, cách xử lý `FIXED_PRICE` cũ khi xếp thứ tự, khóa trùng quà theo *sản phẩm gốc*, rounding theo đơn vị hàng, yêu cầu quà READY/có thể giữ chỗ và cơ chế lưu cấu hình/snapshot. Đây là các quy ước cần được chấp thuận trong vòng review spec; không giả định đã được chủ cửa hàng quyết định.

**BẮT BUỘC XÁC MINH TRƯỚC `/build` CHO LUỒNG PHỤ THUỘC POS VÀ TRƯỚC RELEASE:** Pancake có ghi nhận chính xác (1) dòng quà 0đ, (2) `PAID + GIFT` cùng `pancakeVariationId`, (3) **hai dòng `PAID` cùng `pancakeVariationId` nhưng khác đơn giá** hay không. Nếu chưa có bằng chứng live cho luồng cần dùng, chỉ được bắt đầu `/build` luồng đó khi chủ dự án đã phê duyệt phương án thay thế bảo toàn chính xác tiền, số lượng, audit và đã thêm acceptance tests tương ứng. Bằng chứng custom price dương hiện có không chứng minh các trường hợp này.

## 3. Khái niệm và mô hình đếm

- **Sản phẩm gốc:** `ProductMirror`, ví dụ một mẫu đầm hoặc một mẫu set.
- **Biến thể:** `VariantMirror`, ví dụ đầm A/đỏ/M. Biến thể quyết định tồn kho và màu/size, không làm tăng số mẫu sản phẩm gốc.
- **Chiếc hàng mua:** một đơn vị số lượng của dòng hàng khách trả tiền. 1 set được bán như một sản phẩm = 1 chiếc, dù set có nhiều cấu phần vật lý. Không cộng các thành phần cấu thành set thành nhiều chiếc khi tính khuyến mại.
- **Phạm vi hợp lệ (`eligible products`):** hợp của các sản phẩm được chỉ định trực tiếp và thuộc các danh mục được chọn, sau khi trừ danh sách loại trừ; loại trừ luôn thắng. Chỉ dòng **mua trả tiền** mới được tính.
- **Số lượng hợp lệ `Q`:** tổng `quantity` của **tất cả biến thể và tất cả mẫu** nằm trong phạm vi hợp lệ. Có thể cộng đầm A với đầm B và các size/màu khác nhau.
- **Giá trị hợp lệ `S`:** tổng tiền hàng **sau khi áp dụng tất cả giảm giá được phép**, trước phí vận chuyển, không gồm dòng quà. Có thể tính trên toàn đơn hoặc chỉ dòng mua thuộc phạm vi hợp lệ, tùy Admin chọn.
- **Suất quà:** một quyền chọn một đơn vị quà từ danh sách được cấu hình; không phải tự động thêm quà vào giỏ.
- **Bậc cao nhất:** bậc có `minQuantity` cao nhất không vượt quá `Q`.

## 4. Functional requirements — Admin

### FR-01. Tạo và quản lý chương trình

- Admin vào `/admin/promotions`, tạo/sao chép/chỉnh sửa/xem trước/xuất bản/tạm dừng/kết thúc chương trình theo quyền và vòng đời hiện có (`Draft`, `Scheduled`, `Active`, `Ended`, `Disabled`).
- Chọn rõ `GIFT_ITEM` hoặc `QUANTITY_TIER`; không dùng `FIXED_PRICE` cũ để biểu thị giảm VND/chiếc.
- Bắt buộc có tên, loại, thời gian hiệu lực, phạm vi áp dụng, điều kiện, phần thưởng/giảm giá, cấu hình kết hợp và độ ưu tiên nếu có liên quan.
- Chỉ Admin được thay đổi. Các trường không hợp lệ/không dùng cho loại chương trình được từ chối ở server, không chỉ ẩn ở giao diện.
- Xem trước phải có trường hợp đạt/chưa đạt, số quà hoặc số chiếc giảm, tính tiền và cảnh báo xung đột trước khi publish.

### FR-02. Phạm vi sản phẩm và loại trừ

- Admin chọn theo **danh mục**, **sản phẩm gốc cụ thể**, hoặc kết hợp cả hai.
- Admin loại trừ từng sản phẩm gốc; loại trừ có ưu tiên cao hơn mọi quy tắc chọn vào.
- Có hai chế độ: `DYNAMIC_CATEGORY` (tự nhận sản phẩm mới thuộc danh mục được chọn theo dữ liệu tại thời điểm tính) và `FIXED_PRODUCT_SET` (chụp danh sách product IDs cố định khi kích hoạt, thay đổi danh mục sau đó không tự bổ sung).
- Dữ liệu danh mục website-owned hiện có dùng `ProductCategoryMembership.categoryKey`. Cách kế thừa danh mục cha/con cần thống nhất với category resolver hiện hành; không tự sáng tạo quan hệ phân cấp trong khuyến mại.
- Chương trình chỉ xét sản phẩm/biến thể còn hợp lệ theo trạng thái storefront hiện tại. Thay đổi danh mục/giá/availability phải kích hoạt tái tính quyền lợi trước checkout.

### FR-03. Quà theo số lượng

- Admin chọn `condition = QUANTITY`, `minimumQuantity = N` (số nguyên dương) và danh sách quà.
- Cứ mỗi `N` chiếc hợp lệ, khách có quyền chọn thêm một suất quà: `earned = floor(Q / N)`.
- Nếu Admin đặt `maxGiftsPerOrder`, giới hạn `entitled = min(earned, maxGiftsPerOrder)`; nếu không giới hạn thì `entitled = earned` trong giới hạn kỹ thuật an toàn.
- Ví dụ N=2, Q=6 ⇒ 3 suất; nếu giới hạn 2 thì chỉ 2 suất.

### FR-04. Quà theo giá trị đơn hàng

- Admin chọn `condition = ORDER_SUBTOTAL`, `minimumSubtotalVnd = T > 0`, `subtotalScope = ALL_PAID_LINES | ELIGIBLE_PAID_LINES`.
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

- Khách được chọn từ **0 đến `entitled` suất**; không bắt buộc nhận hết.
- Nếu hàng trong danh sách chỉ còn đủ cấp ít hơn `entitled`, cho phép nhận phần còn lại; nếu hết toàn bộ, cho phép đặt đơn không có quà.
- Trước khi đặt đơn với `selected < entitled`, checkout phải hiển thị **số suất được hưởng / số đã chọn / số bỏ qua hoặc thiếu** và yêu cầu **xác nhận tường minh**. Bao gồm trường hợp khách tự bỏ qua dù còn hàng.
- Không được âm thầm xóa hay đổi quà khi giỏ/tồn kho thay đổi. Nếu quà không còn, báo giá cũ mất hiệu lực và khách phải xem/xác nhận báo giá mới.
- Quyền lợi theo chiến dịch không biến thành phiếu nợ quà giao sau. Order lưu số suất không nhận cùng trạng thái xác nhận.

### FR-07. Giảm giá theo số lượng

- Admin chọn `QUANTITY_TIER`, cấu hình các bậc `(minQuantity, discountValue)`, số nguyên tăng nghiêm ngặt, không trùng ngưỡng; áp dụng **bậc cao nhất đạt được**.
- Admin chọn **một đơn vị giảm giá chung cho toàn chương trình**: `PERCENTAGE` hoặc `FIXED_AMOUNT_PER_UNIT_VND`. Không trộn hai loại trong cùng chương trình.
- Với phần trăm: giảm tỷ lệ trên **giá hiện tại tại bước ưu tiên đó** của từng chiếc được giảm. Với VND: trừ đúng số tiền VND được cấu hình **trên mỗi chiếc được giảm**; không hiểu thành tổng tiền giảm một lần hay giá bán cố định.
- Admin chọn `discountedUnits = ALL_ELIGIBLE_UNITS | FROM_REACHED_THRESHOLD`.
  - `ALL`: tất cả `Q` chiếc hợp lệ hưởng mức của bậc cao nhất.
  - `FROM_REACHED_THRESHOLD`: nếu bậc thắng có ngưỡng `N`, chỉ **`max(0, Q - N + 1)` chiếc** được hưởng mức của bậc thắng; các chiếc còn lại giữ giá tại bước này.
- Khi chỉ giảm một phần, Admin chọn `selectionPriority = CHEAPEST_FIRST | MOST_EXPENSIVE_FIRST`.
- **Quy ước đề xuất:** xếp theo **giá của mỗi chiếc ngay trước bước giảm này**, tie-break ổn định theo `pancakeVariationId` rồi khóa định danh dòng, không theo thứ tự browser gửi.
- Ví dụ Q=5, bậc thắng N=3 giảm 10%, `FROM_REACHED_THRESHOLD` ⇒ 3 chiếc được giảm; nếu Q=3 ⇒ 1 chiếc. Khi chọn `ALL` thì đủ Q chiếc được giảm.
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

### FR-09. Ngữ nghĩa `FIXED_PRICE` legacy

- `PromotionDiscountType.FIXED_PRICE` của hệ thống hiện tại nghĩa là **giá bán cuối theo chiếc**, không phải trừ đi X đồng. Không được đổi dữ liệu lịch sử/ý nghĩa công thức này.
- **Đề xuất cần duyệt:** trong chuỗi giảm giá có cho phép kết hợp, một chương trình legacy fixed-price đóng vai trò **mức giá trần**: `nextUnitPrice = min(currentUnitPrice, configuredFixedPriceVnd)` để không tăng giá đã được giảm trước đó. Nếu không phù hợp với ý định kinh doanh, phải chọn cách xử lý khác trong review spec; không được tự triển khai cách tính này.
- Giảm % và VND mới là bước giảm thực tế trên `currentUnitPrice`; không được làm âm hoặc thành 0đ đối với **hàng mua**.

### FR-10. Quy tắc tiền VND và tồn kho

- Server là authority cho giá, Q, S, danh tính product/variant, phạm vi, tỷ lệ, ưu tiên, kho và số suất quà.
- Sử dụng số nguyên VND an toàn; phép nhân/chia %, cộng dồn cần tránh overflow. **Đề xuất** giữ cách làm tròn half-up bằng `BigInt` đã có trong `promotion-pricing.ts`, ở granularity **mỗi đơn vị hàng** trước khi cộng dòng.
- Đơn giá của hàng mua phải là số nguyên dương; quà tặng có đơn giá thanh toán 0đ **với line role GIFT**. Không cho client giả một dòng mua có giá 0đ.
- Kiểm tra tồn kho quà cùng cơ chế reservation của hàng mua; **cộng nhu cầu vật lý từ tất cả price segments `PAID` và dòng `GIFT` theo cùng `variantId`** trước khi kiểm tra/giữ chỗ. Ví dụ hai dòng `PAID` của một variant với quantity 2+1 chỉ giữ chỗ **3 chiếc vật lý một lần** theo `(orderId, variantId)`, không sinh hai reservation cạnh tranh hoặc giữ chỗ trùng; áp dụng cả khi có `GIFT` cùng variant.
- **Đề xuất để tránh lời hứa tồn kho sai:** quà chỉ chọn từ variant có khả năng giao `READY` được xác minh; hỗ trợ quà composite chỉ khi có kiểm tra/giữ chỗ tài nguyên cấu thành; không mặc định sử dụng quy tắc PREORDER/OVERSELL của hàng mua để cấp quà miễn phí.

### FR-11. Giỏ hàng, checkout và snapshot

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
2. Xác định danh sách campaign hiệu lực và product scope sau exclusion; giải quyết tính tương thích và ưu tiên stack theo cấu hình Admin; nếu conflict không hợp lệ thì từ chối giá mâu thuẫn theo chính sách fail-closed đã duyệt.
3. Tính **giá trả tiền** lần lượt theo priority, cả khuyến mại legacy và tier; Q là **số chiếc paid mua thật trước khi chia price segments**. Xác định bậc cao nhất, ALL/FROM và CHEAPEST/MOST_EXPENSIVE; phân bổ giá từng chiếc rồi nhóm các chiếc đồng nhất về variant/giá/provenance/fulfillment thành nhiều dòng `PAID` có `lineId` ổn định nếu cần, không ép mỗi variation chỉ còn một dòng.
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

## 6. UI/UX và phân quyền

### Admin `/admin/promotions`

- Chọn loại chương trình; form biến đổi theo loại, không hiển thị trường mâu thuẫn.
- Scope picker có danh mục, sản phẩm bổ sung, loại trừ, Dynamic/Fixed, đếm/preview số sản phẩm được ảnh hưởng.
- Gift form có QUANTITY/ORDER_SUBTOTAL; ngưỡng; subtotal scope; ONCE/REPEAT (chỉ ở value); max gift optional; quà theo product và allowlisted variants; allow duplicate.
- Tier form có danh sách bậc, loại giảm %, VND mỗi chiếc; ALL/FROM; CHEAPEST/MOST_EXPENSIVE chỉ khi FROM.
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
- **Eligibility scope**: dynamic category keys hoặc frozen product IDs; includes, excludes; product-only membership. Không thay đổi membership của catalog.
- **Gift rule**: `trigger: QUANTITY | ORDER_SUBTOTAL`, minimum, subtotal scope, repeat mode, max gifts, `allowDuplicateGifts`, product/variant gift allowlist.
- **Tier rule**: discount unit, list of strictly increasing threshold/value, ALL/FROM, CHEAPEST/MOST_EXPENSIVE.
- **Cart gift selection**: cart/campaign/variant/qty, validated server-side; tách khỏi paid `CartItem`. Thay đổi selection làm vô hiệu proof trước đó.
- **Resolved quote lines**: `lineId` duy nhất / role / campaign trên facts canonical do server tạo, **không unique theo variation ID**; một variant có thể sinh nhiều price segments `PAID` ngay cả khi không có gift. Mỗi line giữ nguyên quantity × `unitPriceVnd` = `lineTotalVnd`; quote bao gồm paid/gift, entitlement, acknowledgment và campaign version.
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
- Form parse + lifecycle + quyền Admin; scope include/exclude; category Dynamic/Fixed; parent set và mọi màu/size.
- Gift Q=N−1/N/2N/2N+1, limit; value S=T−1/T/2T+1, ONCE/REPEAT, subtotal ALL/ELIGIBLE, trừ shipping/quà.
- Tier highest-only, %, fixed-VND-per-unit, ALL/FROM, cheapest/expensive, tie deterministic, round half-up, money boundary. **EX-17** phải kiểm tra allocation 2×100.001 + 1×90.001 = 290.003đ, 2 line IDs khác nhau, cùng variation ID, và tính ổn định khi re-resolve.
- Stacking pairwise permission/priority, legacy fixed price, overlap/concurrent mutation/conflict fail-closed, gift evaluated after discounts.
- Duplicate gift product and variant policy; selection partial/zero, invalid selection, camp expired, different gift same total.

**DB/integration:**
- Migration backcompat và revision bump transactional; immutable per-`lineId` order audit; concurrent reservations gộp `PAID+PAID` hai giá cùng variation và `PAID+GIFT` cùng variation **một lần theo tổng quantity**; retry không giữ chỗ trùng.
- Signed quote with gifts/ack và `PAID` price segments; quote proof của EX-17 giữ hai `lineId` và đủ quantity/unitPriceVnd/line total; stale/forged quote; reprice stock/category/rule; signed confirmation of skipped gifts.
- Pancake live acceptance có kiểm soát cho **GIFT 0đ**, **PAID+GIFT cùng variation** và **PAID+PAID cùng variation khác đơn giá** (EX-17); kiểm tra read-back line-level money/quantity/total, rollback/cancel/reconcile/unknown. Nếu POS không hỗ trợ, yêu cầu phương án thay thế được chủ dự án duyệt trước `/build`. Không chạy acceptance có side effects trong CI.
- Existing promotion, shipping, product catalog, Merchant/Meta Purchase, preorder/composite regressions.

**Browser/E2E và accessibility:**
- Admin tạo gift theo Q và S với cả hai scopes, chế độ nhân/once, duplicate cap và product variants; tạo tier giá % và VND; xem preview/priority.
- Cart 1 đầm + 1 set, nhiều size cùng mẫu, chọn 2 quà khác nhau/trùng khi được phép; vượt/mất ngưỡng.
- Khách bỏ 1/all gifts, partial stock, out of stock, giao diện xác nhận; đổi quà khiến quote mất hiệu lực.
- Keyboard/focus/labels/announcement, mobile/cart/checkout; test thời điểm chương trình bắt đầu/kết thúc.

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
- Stage rollout: domain/DB tests → admin preview/sandbox → quote/order integration → controlled Pancake zero-price evidence → E2E/accessibility → owner review → bật có kiểm soát; kill switch phải dừng tạo quote mới theo luật mới mà không làm sai các order đã hoàn tất.
- Metrics/log không PII: promotion candidate/conflict, quote/requote, gift entitled/selected/unclaimed, stock insufficiency, stale proof, price divergence, Pancake accepted/rejected/unknown, idempotency dedupe. Alert cho xung đột active, tồn kho âm/quà trùng, POS quote mismatch.
- **Always:** giữ chuẩn authz, validation, integer money, atomic reservation, proof, migrations, tests, docs, feature gating và Definition of Done trong `05_SHARED_REFERENCES.md`.
- **Ask first:** thay đổi semantics legacy `FIXED_PRICE`, cấu trúc tables khi dữ liệu thật có migration rủi ro, trường hợp adapter Pancake cần compromise, thêm dependencies, điều chỉnh ship/SEO/analytics, đổi behavior legacy overlap.
- **Never:** đổi giá catalog của Pancake, tin giá/quà từ browser, xuất order/POS lệch quote, tự bỏ quà không xác nhận, ship tính quà như paid, sửa lịch sử đơn, báo đã được Pancake hỗ trợ 0đ khi chưa thử.

## 11. Acceptance criteria tổng hợp (definition of success)

- [ ] AC-01 Admin tạo được `GIFT_ITEM` với QUANTITY hoặc ORDER_SUBTOTAL, chọn ALL/ELIGIBLE subtotal và ONCE/REPEAT phù hợp.
- [ ] AC-02 Admin cấu hình Dynamic/Fixed scope gồm category + product includes/excludes; số chiếc được cộng giữa mọi mẫu/biến thể hợp lệ, set tính đúng một chiếc.
- [ ] AC-03 Admin quản lý được danh sách quà product + allowed variants, cho/không cho trùng và max gifts/đơn tùy chọn.
- [ ] AC-04 Earned/selected gift slots luôn đúng tại ranh giới; khách chọn được 0..entitled, kể cả khi kho thiếu một phần/toàn bộ, với xác nhận bắt buộc nếu không nhận đủ.
- [ ] AC-05 Tier chọn highest threshold only; %/fixed VND per unit, ALL/FROM, CHEAPEST/MOST_EXPENSIVE đúng; khi FROM giảm một phần cùng variant, **hai dòng PAID khác giá** được lưu/ký riêng và bảo toàn chính xác 290.003đ ở EX-17.
- [ ] AC-06 Campaign stacking và thứ tự priority do Admin thiết lập; mỗi bước dùng giá còn lại, không làm tăng/âm/zero giá trả tiền.
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

**R-05 — Cách diễn giải `FROM_REACHED_THRESHOLD` khi nhiều bậc:** đề xuất số chiếc giảm = Q − N(thắng) + 1, mức giảm của bậc thắng, ranking theo giá ngay trước step.

**R-06 — POS acceptance (hard blocker):** kiểm chứng live có operator phê duyệt cho (a) quà giá 0đ, (b) PAID+GIFT trùng variation, (c) **PAID+PAID trùng variation với giá khác nhau**; read-back unit/quantity/totals, cancel/reconcile, rollback an toàn. Nếu (c) không đạt, trước `/build` phải có phương án thay thế được chủ dự án duyệt, giữ chính xác 290.003đ của EX-17; không bình quân/làm tròn giá. Các gate (a)/(b) vẫn độc lập.

**R-07 — Phân cấp category:** xác minh category scope cha/con và snapshot fixed theo category resolver site-owned đang dùng, tránh tính sản phẩm ngoài danh mục Admin nghĩ mình đã chọn.

**Trạng thái cuối:** hoàn thành bản spec để **chủ dự án review và duyệt**. **Chưa `/plan`, chưa `/build`, chưa migration/code change, chưa chạy tests hoặc nghiệm thu Pancake trong lượt này.**
