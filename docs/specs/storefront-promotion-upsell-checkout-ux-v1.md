# Spec — Trải nghiệm ưu đãi, gợi ý mua thêm và thanh toán COD (UX-COMMERCE-001)

**Ngày cập nhật:** 2026-10-17
**Trạng thái:** DRAFT v1.3 — spec-only, để owner review; chưa phê duyệt implementation. **Khuyến nghị của spec cho upsell: phương án B** (§6, UX-07) — là khuyến nghị, không phải phê duyệt.
**Baseline hiện tại:** `main@c6058a1c938df31fcff04108da9cee8e8b4bca4d` — sau khi `main` được đưa về trước PR #178/#180 (`3cbbbaec`) và PR #177 đã merge. Checkout upsell tại baseline vẫn có chọn biến thể và thêm hàng trực tiếp; cart đã có một picker quà ở đầu trang, trước hàng mua.
**Phụ thuộc:** PR #181 (phương án A — banner `/sale`) chưa merge; chi tiết ở §2. Trạng thái PR, lịch sử nhánh và quality gate của PR tài liệu nằm trong mô tả PR, không ghi trong spec.
**Phạm vi:** spec-only, đi cùng [storefront-funnel-measurement-v1.md](storefront-funnel-measurement-v1.md). Không kèm thay đổi runtime, test, database, CI, dependency package hoặc feature flag.

## 0. Owner cần quyết

Mọi điểm cần owner chốt gom tại đây; mỗi dòng ghi phần nào bị chặn nếu chưa quyết. Khuyến nghị của spec không phải phê duyệt.

| ID | Quyết định | Khuyến nghị của spec | Chặn phần nào |
| --- | --- | --- | --- |
| OD-01 | Phương án upsell checkout: A (banner `/sale`, PR #181) hay B (inline thu gọn) — UX-07 | **B**; A cần amendment `D-03/D-04`, `U-02/A`, `FR-06/07/08/09/12` | Toàn bộ implementation upsell (UX-06/07, AC-06/07/08) |
| OD-02 | Gate đo lường MEAS-06: sink/schema UX, khóa lượt ngẫu nhiên và consent, cửa sổ attribution ([spec đo lường](storefront-funnel-measurement-v1.md)) | Duyệt nếu muốn đánh giá B bằng chỉ số Mức 1; nếu không, chỉ đo Mức 0 | Chỉ số Mức 1 (M-03, M-04, M-07 và M-02/M-06 theo lượt) |
| OD-03 | Độ dài cửa sổ baseline số đo trước khi đổi UI | Đủ số lượt checkout để ổn định; tránh trùng đợt sale lớn hoặc ghi rõ khi trùng | So sánh trước/sau cho B |
| OD-04 | Chọn phường/xã: giữ `<select>` gốc hay đổi sang ô chọn có tìm kiếm (danh sách sau sáp nhập có thể dài hàng trăm dòng) | Combobox tự xây theo mẫu ARIA combobox/listbox, **không thêm package**; giữ `<select>` gốc khi script lỗi; giá trị gửi vẫn là id từ geo action | Phần địa chỉ của UX-09 và AC-12 |
| OD-05 | Thông tin tin cậy COD cạnh nút đặt hàng: thời gian giao dự kiến, đổi trả, “không cần trả trước” | Chỉ dùng câu và link đã có trong [la-na-design-policy-authority.md](la-na-design-policy-authority.md) (`/shipping`, `/returns`); thời gian giao chỉ khi có số liệu owner xác nhận; owner duyệt từng câu | Khối tin cậy COD trong UX-09 |
| OD-06 | Hiện phí ship ở cart trước khi có quote; có thanh tiến độ freeship hay không | Hiện mức cơ bản theo chính sách server (U-01/A đã duyệt 30.000đ, `guest-shipping-policy.ts`) với chú thích “tính chính xác ở bước thanh toán”; không hiện khi không đọc được chính sách. Thanh tiến độ freeship chỉ khi có chính sách freeship được duyệt | Phần phí ship của UX-02 |

## 1. Mục tiêu, người dùng và kết quả mong muốn

Khách mua hàng thời trang trên mobile hoặc desktop cần:
1. Nhận ra **đã được giảm bao nhiêu / có quà gì / còn thiếu gì để đạt mốc**, không cần hiểu tên campaign hay cơ chế tính quote.
2. Xem và chọn quà tặng **không nhầm với hàng phải trả tiền**, không gặp CTA “Chọn quà” trùng hoặc bước lưu bị hiểu là đã hoàn tất.
3. Nhìn thấy gợi ý mua thêm **như một lựa chọn phụ, có giá trị được chứng minh**, không bị kéo khỏi luồng thanh toán ngoài ý muốn.
4. Điền thông tin, thấy tổng tiền chính xác theo báo giá hiện hành, xử lý lỗi và hoàn tất COD **không mất dữ liệu đã nhập hoặc tạo đơn trùng**.

Đây là **spec cải thiện presentation và interaction**, không viết engine ưu đãi mới. Thành công được đánh giá qua các hành vi và kịch bản AC ở §9; không tự gán chỉ tiêu tăng conversion hoặc điểm Lighthouse khi chưa có số đo. Cách đo phễu (số liệu trước và sau thay đổi) nằm ở [spec đo lường](storefront-funnel-measurement-v1.md); chỉ tiêu cụ thể do owner đặt sau khi có baseline số đo.

### Giả định và điểm cần owner duyệt

- **G-01 (baseline):** `CheckoutUpsell` trên `main@c6058a1` vẫn render sản phẩm, dropdown biến thể, ước tính chênh tổng tiền và nút “Thêm 1 chiếc”. Banner dẫn `/sale` là **đề xuất đang review trong PR #181**, không phải UI hiện hành của baseline. Không suy hiện trạng từ nhãn “merged” lịch sử của PR #178/#180.
- **G-02 (đề xuất):** ưu tiên checkout ngắn gọn; spec **khuyến nghị B** (thu gọn upsell inline hiện có, giữ thêm hàng tại checkout) thay vì chuyển sang banner `/sale`. Khuyến nghị không thay phê duyệt: owner vẫn chốt A/B tường minh qua UX-07 trước implementation.
- **G-03 (cart, đã merge):** PR #177 đã merge (`c6058a1`): cart có **một** picker quà chức năng ở đầu trang, trước hàng mua; banner `GIFT achieved` trùng bị lọc khi picker hiện, `TIER achieved` và `GIFT progress` vẫn giữ (`src/app/cart/page.tsx`). Spec này coi bố cục đó là hiện trạng; các AC cart (AC-01/02) trở thành regression để không làm hỏng nó, không phải yêu cầu dựng lại.
- **G-04 (bảo toàn):** giữ hợp đồng quyền nhận, không nhận đủ quà, quote/proof, không tự thay quà, chống race và điều kiện POS đã duyệt ở các spec trước.
- **G-05 (approval gate):** spec upsell gốc đã ghi `D-03` (chọn biến thể và thêm trực tiếp tại checkout), `D-04` (hiển thị tối đa 3–5 mẫu) và `U-02/A` (quà mở qua upsell được chọn ngay checkout). Phương án A khác những quyết định này; PR #181 đang mở và lịch sử merge #178/#180 **không thay thế phê duyệt nghiệp vụ**. Bảng UX-07 nêu phạm vi phải chốt.

## 2. Tài liệu và phụ thuộc

| Nguồn | Vai trò |
| --- | --- |
| [gift-quantity-promotions-v1.md](gift-quantity-promotions-v1.md) | Quy tắc tặng quà, số suất, inventory, stacking, acknowledgement |
| [storefront-gift-picker-checkout-reminder.md](storefront-gift-picker-checkout-reminder.md) | Luồng picker tại cart/checkout, bỏ rồi chọn lại, popup nhắc **một lần**, gồm nhánh không còn lựa chọn hợp lệ |
| [smart-promotion-upsell-v1.md](smart-promotion-upsell-v1.md) | Quyết định owner: **D-03, D-04, U-02/A, FR-06/07/08/09/12**; đối chiếu với phương án trong PR #181, không coi đề xuất code là duyệt sửa spec |
| [storefront-mobile-commerce-ux.md](storefront-mobile-commerce-ux.md) | Responsive/touch/focus và thứ tự checkout mobile hiện có |
| `src/routes/cart-promotion-model.ts`, `src/routes/cart-gift-model.ts`, `src/routes/checkout-model.ts` | Quyền lợi, copy, tiền và các trạng thái có dữ liệu nguồn |
| `src/components/brand/promotion-banner.tsx`, `cart-gift-picker.tsx`, `cart-drawer.tsx` | Presentation ưu đãi và quà |
| `src/components/commerce/checkout-upsell.tsx`, `guest-checkout-form.tsx`, `src/app/checkout/page.tsx` | Upsell inline ở baseline, một form COD, summary và popup |

**Nguyên tắc ưu tiên:** business/security rules ở spec hiện hành tiếp tục có hiệu lực. Tài liệu này đề xuất UX bổ sung; điểm nào đụng một quyết định đã duyệt phải quay lại owner. Không lấy trạng thái PR hoặc code của một nhánh chưa merge làm hợp đồng đang áp dụng.

### Phụ thuộc

- **PR #177 — đã merge vào baseline `c6058a1`:** bố cục cart một picker ở đầu trang là hiện trạng, được `tests/a11y-runtime/cart-gift-picker.spec.ts` khóa; AC-01/02 là regression.
- **PR #181 — đang mở:** là đề xuất runtime cho phương án A (banner `/sale`). Không phải hiện trạng, không phải phê duyệt; quan hệ với spec ở UX-06/07 và AC-06/07/16.
- **PR #178/#180:** chỉ là lịch sử thiết kế, nội dung không thuộc `main` hiện tại và không thay phê duyệt nghiệp vụ.
- **Khi baseline đổi:** nếu `main` di chuyển hoặc #181 đổi hướng/merge/đóng, kiểm tra lại §3 với source mới trước khi triển khai phần phụ thuộc; không suy bản cũ đã được nghiệm thu.

## 3. Hiện trạng kiểm tra từ source (không phải kết quả browser)

| Bề mặt | Hiện trạng tại `main@c6058a1` | Hệ quả UX / cần xác minh |
| --- | --- | --- |
| PDP / listing | Thẻ sản phẩm có giá sale/badge, purchase panel dùng state biến thể dùng chung | Kiểm tra tên ưu đãi/giá; không gộp giá Flash Sale với thưởng cart nếu không có quote |
| Mini-cart | `PromotionBanner` liên kết `/cart#cart-gifts`, hàng mua và totals trong drawer | Đích là picker thật ở đầu cart (#177), nhưng picker mặc định thu gọn và không đọc hash: khách tới nơi còn phải bấm “Chọn quà ngay”. Yêu cầu mở sẵn khi tới qua anchor: UX-05; không mô tả link cuộn như thao tác nhận quà |
| Cart | Một picker ở đầu cột chính, trước `PromotionBanner` và hàng mua (#177); `GIFT achieved` bị lọc khi picker hiện, TIER/progress giữ. Ở mobile, summary và “Tiến hành đặt hàng” xếp sau toàn bộ hàng mua | Giữ bố cục làm regression; xác minh khách vẫn thấy tổng/CTA mà không phải cuộn quá xa khi giỏ nhiều dòng |
| Checkout | Banner ưu đãi trước form; picker ở order panel; mobile summary thu gọn, desktop summary sticky | Kiểm tra thông báo cùng quyền lợi bị lặp giữa banner, danh sách đơn và picker |
| Checkout upsell | Còn danh sách sản phẩm (tối đa 5), mỗi mẫu có ảnh, `<select>` biến thể, estimate và nút “Thêm 1 chiếc”; tiêu đề dùng tên campaign. Render **đầu cột trái, trước “Thông tin nhận hàng”**; ở mobile nằm sau summary + picker, nên khách gặp khối gợi ý trước ô nhập đầu tiên. Đổi biến thể gọi requote và khóa cả form | Rà soát mật độ, vị trí, lựa chọn đang chờ báo giá và vị trí feedback; không mô tả như banner dẫn `/sale`. Đây là đầu vào cho khuyến nghị B (UX-07) |
| Test upsell | `tests/a11y-runtime/promotion-upsell.spec.ts` kiểm tra chọn variant, thêm inline, refresh proof và giữ form | Các control đó **có trong baseline**; mismatch do bỏ control là rủi ro của phương án A/#181, không phải kết luận lỗi hiện tại của `main` |
| Quote không sẵn sàng | Thiếu `quoteProof` khóa submit; `unavailableNotice` gần tổng kết cuối | Có thể thấy cảnh báo muộn; cần đưa lý do và hành động sửa đến đúng vị trí |
| Gift picker | `draft` khác `selections`; nhãn “chưa thêm” dựa trên `draftSaved` | Tái hiện nhận rồi bỏ quà để kiểm tra cảnh báo draft sai ngữ cảnh |

**Ngoài baseline:** banner gọn và điều hướng `/sale` của PR #181 là phương án đang review. Rủi ro mất form khi rời checkout và test inline không còn control chỉ được gắn với nhánh/phương án đó. Không khẳng định các rủi ro đã tái hiện bằng browser hoặc ở production; các kịch bản cần bằng chứng runtime nằm ở §9.

## 4. Hợp đồng UX liên bề mặt

### UX-01 — Một quyền lợi, một thông điệp rõ ràng tại mỗi điểm hành động

- Phân biệt **đã áp dụng giảm giá**, **đã đủ điều kiện nhận quà**, **đã thêm quà vào đơn**, **tiến độ đến mốc tiếp theo**. Không dùng “được nhận” để ngụ ý quà đã lưu.
- Tại từng vùng thao tác, **chỉ một CTA chính cho cùng hành động**. Banner được chứa TIER/progress nhưng không lặp CTA “Chọn quà” khi đã có picker tương tác ngay tại đó.
- Không ẩn mất `TIER achieved` hoặc `GIFT progress` chỉ để bỏ `GIFT achieved` lặp; không ẩn lỗi/quyền lợi không khả dụng.
- Mini-cart có thể dẫn tới `/cart#cart-gifts` khi cart có picker/anchor thật tương ứng; không đủ quyền nhận thì không render lời mời nhận quà giả.
- Số tiền, điều kiện đạt mốc, số suất, phần trăm và giá lấy từ model/quote canonical, không tính từ DOM, text badge hay client.

### UX-02 — Ưu tiên việc khách đến để làm

- PDP: giá và biến thể đang mua là chính; khuyến mại hỗ trợ quyết định, không lấn CTA mua.
- Cart: hàng mua khác quà được chọn, tổng tiền rõ, chỉ một picker — **bố cục picker đầu trang của #177 đã là baseline**; thay đổi cart sau này không được tách lại thành hai picker hay hồi lại CTA quà trùng.
- Checkout: ưu tiên **thông tin nhận hàng + tổng thanh toán + nút đặt COD**. Mua thêm là tùy chọn, không bắt khách giải quyết mới được thanh toán.
- Mobile: summary luôn truy cập được, picker ngay sau vùng danh sách đơn kể cả lúc thu gọn theo spec picker; không đưa cả hàng mua vào picker.
- **Thanh dính đáy màn hình (mobile, cart và checkout):** khi nút chính (“Tiến hành đặt hàng” ở cart, “Đặt hàng COD” ở checkout) đang ngoài màn hình, hiện một thanh dính đáy gồm tổng tiền theo quote đang hiển thị và một nút. Ở cart, nút là link tới `/checkout` với cùng điều kiện `canCheckout`; ở checkout, nút đi qua **cùng pipeline submit** của form (không phải submit thứ hai), mang cùng trạng thái khóa và lý do khóa. Thanh ẩn khi nút chính đã trong màn hình (chỉ một CTA chính hiển thị tại một thời điểm), khi bàn phím ảo mở và khi popup/dialog đang mở; không che trường đang nhập hay thông báo lỗi; desktop không có thanh này.
- **Phí ship ở cart (theo OD-06):** khi chưa có quote đầy đủ, chỉ hiện mức phí cơ bản lấy từ chính sách server kèm chú thích tính chính xác ở checkout; không tự tính, không hiện khi chính sách không đọc được.
- Desktop: giữ một form workflow và order summary sticky, không mount hai controller để đổi bố cục.

### UX-03 — Nội dung ngắn, nhất quán, không tạo lời hứa sai

Ví dụ copy, chỉ minh họa; con số và khả năng chọn lấy từ dữ liệu động:
- Có quyền và còn lựa chọn hợp lệ: **“Bạn có 2 suất quà. Đã thêm 0/2 quà.”** CTA **“Chọn quà”** chỉ khi thực sự còn phần chọn được.
- Có quà đã lưu: **“Đã thêm 1/2 quà vào đơn”**; giải thích riêng phần chưa thể nhận.
- Hết lựa chọn hợp lệ: **“Hiện chưa có lựa chọn phù hợp cho 1 suất quà còn lại.”** Không tự nói hết hàng khi nguyên nhân là cấm trùng mẫu/stock chung.
- Upsell: **“Thêm 1 sản phẩm phù hợp để đạt [quyền lợi được quote chứng minh]”**. Chỉ hiện chi phí tăng thêm khi biết biến thể và quote đáng tin; link tới trang bán hàng không chứng minh mọi mẫu ở đó đều đủ điều kiện.
- Lỗi báo giá: **“Giỏ hàng cần được kiểm tra lại”** + lối thử lại/sửa tại chỗ, giữ form.

Không thêm toast/modal chỉ để lặp cùng status; dùng phản hồi cạnh action và một status vùng phù hợp cho screen reader.

## 5. Chọn quà — giao diện và vòng đời trạng thái

### UX-04 — Chọn / lưu / bỏ / sửa tại chỗ

- Phân biệt **đang xem phiên bản**, **đang lưu**, **đã lưu**, **kết quả chưa rõ**; chip được chọn chưa được tính là quà của đơn.
- Một thẻ quà mở tại một thời điểm; có ảnh/fallback, tên, phiên bản, tình trạng và nút **“Nhận quà này”** chỉ bật khi server model cho phép.
- Đủ suất vẫn duyệt mẫu khác được nhưng không nhận thêm. Thay quà theo **bỏ trước, chọn lại sau**, không hứa hoán đổi nguyên tử hoặc tự phục hồi món đã bỏ.
- Nhận quà rồi chủ động bỏ lại không được **hồi sinh lời nhắc draft “chưa thêm” về hành động đã kết thúc**. Chỉ kết thúc intent cũ sau kết quả xác nhận/readback; không xóa draft mới khách chủ động chọn trong lúc đợi.
- Bỏ/giảm số quà giữ focus tại nút còn hợp lệ hoặc vùng picker có tên, không về body; không đánh dấu lỗi khi khách chủ động để trống suất.
- Quote/gift-invalid cho sửa tại checkout, không điều hướng làm mất form. Pending/unknown khóa submit, upsell và thao tác quà xung đột.

### UX-05 — Rút gọn nhưng vẫn có thể quản lý

- Thu gọn: số quà đã lưu/còn có thể chọn/không thể cấp + một CTA phù hợp; không trưng cả danh sách và nút bỏ.
- Mở rộng: có thẻ lựa chọn và quà đã lưu với thao tác rõ; phản hồi thành công/thất bại tại nơi khách vừa thao tác.
- Không tự thu gọn, điều hướng hoặc submit khi nhận đủ món cuối cùng.
- Chỉ một `#cart-gifts` cho bề mặt hiện hành và một controller trạng thái.
- **Tới qua anchor:** khi trang mở hoặc đổi hash sang `#cart-gifts` (ví dụ từ “Chọn quà” trong mini-cart), picker tự mở rộng, cuộn tới và nhận focus vùng có tên. Không tự chọn biến thể, không tự lưu quà; nếu không còn lựa chọn hợp lệ thì mở phần giải thích, không mở CTA giả.

## 6. Gợi ý mua thêm — hiện trạng và phương án chờ duyệt

### UX-06 — Không thay runtime bằng việc duyệt spec

- **Hiện trạng:** baseline vẫn có upsell inline. Spec này không đổi runtime; không bỏ dropdown/nút thêm, không đổi link, không sửa test để phù hợp một giao diện chưa được duyệt.
- **Mục tiêu:** làm gợi ý gọn và không bắt buộc. Cách trình bày theo A/B chỉ được triển khai sau quyết định UX-07 và kết luận phần liên quan của PR #181; spec khuyến nghị B.
- Không khẳng định thêm đúng một chiếc sẽ mở quyền lợi khi server không còn offer hợp lệ; chỉ công bố estimate dựa trên variant/quote đã xác minh.
- **Chỉ với A:** banner dẫn `/sale` là đường rời checkout được đề xuất trong #181. Nếu form đã nhập, cần xử lý dễ hiểu và dùng được bằng bàn phím trước exit; đề xuất cảnh báo mất thông tin chưa gửi, chọn ở lại giữ form/focus. Không tự lưu PII vào storage và không tự thêm hàng.
- Dismiss chỉ ẩn đề xuất theo lượt đã duyệt; không ẩn picker/quyền nhận, reset quote/submit hoặc làm khóa đơn.

### UX-07 — Quyết định sản phẩm phải được owner phê duyệt tường minh

**Đối chiếu:** spec upsell gốc quy định `D-03` chọn biến thể và thêm một chiếc **tại checkout**, `D-04` hiển thị tối đa 3–5 mẫu hợp lệ, `U-02/A` chọn quà do upsell mở **ngay checkout**. `FR-07/08/09/12` chi tiết hóa giá, biến thể, thêm hàng, quà và accessibility. Baseline hiện vẫn có tương tác inline. PR #181 đề xuất bỏ tương tác này để dùng banner `/sale`; **không phải hiện trạng hay quyết định đã được phê duyệt qua #179**.

**Phương án A — đề xuất banner trong PR #181, CHƯA được duyệt thay yêu cầu:** nút “Tiếp tục mua sắm” đến `/sale`; có xử lý khi rời form đã nhập. `/sale` không được hứa chỉ có ứng viên đã chứng minh hay cho thêm +1 ngay checkout. Chọn A đòi owner phê duyệt thay `D-03`, `D-04` và hành trình unlock gift của `U-02/A`; không bỏ picker quà ở checkout. Nội dung #181 chưa tự chứng minh mọi tiêu chí A, nhất là giữ/đóng form, accessibility và test thay thế.

**Phương án B — cải thiện presentation inline hiện có, chỉ triển khai sau khi duyệt:** phần mở rộng **một ứng viên mỗi lần**, có ảnh/tên/variant/giá/chênh tổng tiền do server xác minh, add đúng +1 qua action/proof hiện có. Vẫn truy cập được tập tối đa 5 mẫu hợp lệ, không mở nhiều form. Quà mới chọn ngay checkout, giữ thông tin nhận hàng và khóa submit tới quote mới. Không tạo engine giá hoặc auto-add. Chọn B không đồng nghĩa lấy code banner #181; cần điều phối để hai hướng không ghi đè nhau.

Thiết kế B đề xuất (presentation; logic, proof và mutation giữ nguyên):
- **Vị trí:** chuyển khối gợi ý từ đầu cột trái xuống **sau các trường địa chỉ, ngay trước “Tổng kết thanh toán”**, nơi khách đang xem tổng tiền và chênh lệch có nghĩa. Không đứng trước ô nhập đầu tiên ở mobile. Vẫn thuộc cùng form/controller, không mount bản thứ hai theo breakpoint.
- **Mặc định thu gọn:** một dòng nêu **lợi ích được quote chứng minh** (ví dụ “Thêm 1 sản phẩm để nhận thêm 1 quà”), không dùng tên campaign làm tiêu đề; một nút mở rộng có `aria-expanded`, và nút “Không mua thêm” giữ nguyên ngữ nghĩa dismiss `D-06`.
- **Mở rộng:** một ứng viên hiển thị đầy đủ (ảnh, tên, giá “từ”), các ứng viên còn lại dạng danh sách gọn chọn được để đổi card mở (vẫn đủ `D-04`). Chọn biến thể bằng **chip** giống gift picker và `storefront-variant-selector-ui.md` thay cho `<select>`; chỉ sau requote thành công mới hiện chênh tổng tiền và bật “Thêm 1 chiếc”.
- **Phản hồi:** trạng thái requote/add hiện cạnh card, đồng thời một dòng trạng thái ngắn cạnh nút “Đặt hàng COD” khi submit bị khóa vì upsell đang chờ, để khách không thấy nút tắt mà không có lý do.
- **Sau khi thêm:** card thu lại thành xác nhận “Đã thêm …”, picker quà mới mở ở cùng checkout theo `U-02/A`, focus đến vùng quà hoặc thông báo kết quả, form giữ nguyên.

Thứ tự khối ở checkout mobile (~390px), trước và sau B (kèm các yêu cầu UX-02/08/10 liên quan). Đây là sơ đồ thứ tự, không phải thiết kế hình ảnh; AC-17 vẫn cần ảnh runtime.

```text
HIỆN TẠI (main@c6058a1)                 ĐỀ XUẤT (B + UX-02/08/10)
┌───────────────────────────────┐       ┌───────────────────────────────┐
│ Ưu đãi của bạn (banner)       │       │ Ưu đãi của bạn (banner)       │
│ Đơn hàng (n) · tổng      [+]  │       │ Lý do chặn + cách sửa (UX-08) │
│ Quà dành cho bạn (picker)     │       │ Đơn hàng (n) · tổng      [+]  │
│ GỢI Ý THÊM ĐỂ ĐẠT ƯU ĐÃI      │       │ Quà dành cho bạn (picker)     │
│  · tối đa 5 mẫu, mỗi mẫu:     │       │ Thông tin nhận hàng           │
│    ảnh, <select>, giá,        │       │  Họ tên · SĐT                 │
│    “Thêm 1 chiếc”             │       │  Tỉnh · Phường/xã · Địa chỉ   │
│ Thông tin nhận hàng           │       │  Ghi chú                      │
│  Họ tên · SĐT                 │       │ ▸ Thêm 1 món để nhận thêm 1   │
│  Tỉnh · Phường/xã · Địa chỉ   │       │   quà            [Xem gợi ý]  │
│  Ghi chú                      │       │ Tổng kết thanh toán           │
│ Tổng kết thanh toán           │       │ Còn 1 quà chưa chọn [Chọn quà]│
│  (lý do chặn hiện ở đây)      │       │ Lý do khóa (nếu có)           │
│ [ Đặt hàng COD ]              │       │ [ Đặt hàng COD ]              │
└───────────────────────────────┘       ├───────────────────────────────┤
                                        │ dính đáy khi nút ngoài màn    │
                                        │ hình: Tổng · [Đặt hàng COD]   │
                                        └───────────────────────────────┘
```

| Yêu cầu/decision đang được ghi nhận | A — banner tới `/sale` | B — inline compact | Phê duyệt/cập nhật bắt buộc |
| --- | --- | --- | --- |
| **`D-03`**: variant + add trực tiếp ở checkout | **Không đáp ứng** | Giữ hành vi, đổi presentation | A phải được owner duyệt thay `D-03` |
| **`D-04`, `FR-06`**: trình bày 1–5 mẫu hợp lệ | **Không đáp ứng phần hiển thị** | Tối đa 5 mẫu truy cập được, một card mở | A cần duyệt sửa `D-04`/UI `FR-06`; không tự bỏ giới hạn query |
| **`FR-07/08/12`**: variant/estimate, thêm an toàn tại checkout, a11y | **Không đáp ứng phần tương tác inline** | Giữ logic/proof, rút gọn UI | A cần duyệt thay flow; B không nới proof/stock |
| **`U-02/A`, `FR-09`**: unlock gift → chọn tại checkout | Mua thêm qua `/sale` đổi hành trình; quay lại vẫn phải chọn được mọi quà hợp lệ ở checkout | Giữ add → unlock → chọn quà tại checkout | A cần duyệt thay hành trình, **không bỏ picker checkout** |
| **`D-01/02/05/07/08`, `U-01/A`, `FR-04/05`**: cơ hội, quote, cost, tồn kho | Giữ policy server để phát offer; không hứa cost/variant không có bằng chứng | Giữ policy cho lựa chọn và mutation | Không sửa pricing/campaign/stacking/stock authority |
| **`D-06`, `FR-10/11`**: dismiss và lỗi | Giữ | Giữ | Không reset sai lượt hoặc auto-retry |

**Khuyến nghị của spec: chọn B** (cần owner xác nhận; chưa là phê duyệt):
1. **Không đưa khách rời checkout khi form đang dở.** A dẫn sang `/sale` ở bước cuối phễu; khách phải tìm sản phẩm, quay lại và có thể mất dữ liệu chưa gửi. Rủi ro bỏ đơn này lớn hơn lợi ích gọn giao diện.
2. **Không cần amendment.** B đáp ứng `D-03`, `D-04`, `U-02/A`, `FR-06/07/08/09/12` đã duyệt; A phải sửa cả năm nhóm này.
3. **Tận dụng phần đã kiểm chứng.** Proof, khóa phối hợp, readback khi mất phản hồi và stale-offer đã có test DB/browser; B chỉ đổi presentation và vị trí, phạm vi rủi ro nhỏ hơn A.
4. **Đúng mục tiêu “gọn”.** Vấn đề chính ở baseline là mật độ và vị trí (khối gợi ý đứng trước ô nhập ở mobile), không phải bản thân việc thêm hàng inline; B xử lý trực tiếp hai điểm đó.

Điều kiện xem lại khuyến nghị: nếu số đo theo [spec đo lường](storefront-funnel-measurement-v1.md) sau khi triển khai B cho thấy upsell vẫn làm giảm tỉ lệ hoàn tất checkout (so với baseline) mà tỉ lệ thêm hàng thấp, owner có thể cân nhắc A hoặc bỏ upsell ở checkout qua amendment riêng; quyết định dựa trên số đo, không dựa trên lịch sử merge #178/#180.

**Decision gate:** chốt **A hoặc B tường minh** trước implementation phần upsell. A cần amendment/supersession được duyệt cho `docs/specs/smart-promotion-upsell-v1.md`, nêu `D-03/D-04`, `U-02/A`, `FR-06/07/08/09/12`, luồng `/sale` và test; thiếu bước này không coi A đáp ứng spec gốc. B cần duyệt cách thu gọn inline và kết luận phối hợp #181. Không mặc định A/B, không dùng việc #178/#180 từng merge làm approval; những thay đổi runtime và amendment thực thi nằm ở PR riêng.

## 7. Checkout COD — hỗ trợ hoàn thành và sửa lỗi

### UX-08 — Checkout chưa sẵn sàng phải thấy lý do sớm

- `unquotable`, thiếu proof, quà invalid hoặc lỗi nguồn địa chỉ nghiêm trọng: thông báo và hướng xử lý xuất hiện **trước dãy trường nhập**; có ngữ cảnh cạnh tổng kết/submit khi cần.
- Không để CTA disabled với câu chung “chưa thể đặt hàng” mà thiếu hướng sửa. Sửa quà, cập nhật báo giá, chọn địa chỉ lại ưu tiên tại chỗ.
- Chỉ nâng thông báo UI, không tự phát hành proof hay cho submit khi chưa hợp lệ.
- Giá/stock/ship đổi: hiện **tổng cũ → tổng mới** (ví dụ “Tổng thanh toán đã đổi: 520.000 ₫ → 545.000 ₫”) kèm lý do ngắn khi server cung cấp, và cần một hành động xác nhận/submit **chủ động**, không tự tiếp tục sau refresh. Tổng cũ là tổng của render/proof khách đã submit, tổng mới là giá trị server trả về; cả hai đều từ server, client không tính hiệu số hay tự suy lý do.
- **Cart không cho thanh toán:** thông báo cạnh nút liệt kê từng dòng hàng cần xử lý, mỗi mục là link nhảy tới đúng dòng; dòng đó được đánh dấu bằng chữ (ví dụ “Cần xử lý: hết hàng”), không chỉ bằng màu, và nhận focus khi khách theo link. Lý do lấy từ cart model, không tự suy.

### UX-09 — Tổ chức giao hàng và tổng kết

- Mobile: đơn có thể thu gọn, nhưng tổng thanh toán luôn thấy trước nút đặt; quà không ẩn bên trong summary đóng.
- Desktop: một summary sticky ở cột phụ, một form, thứ tự đọc/tab hợp lý.
- Tên, điện thoại, tỉnh/thành, phường/xã, địa chỉ, ghi chú có nhãn và autocomplete phù hợp; lỗi sát trường, focus trường lỗi đầu khi submit sai.
- Đổi tỉnh chỉ reset phần địa chỉ phụ thuộc; geo read lỗi có retry **không xóa tên/điện thoại/địa chỉ chi tiết/ghi chú**.
- Chọn phường/xã: theo OD-04. Nếu duyệt ô chọn có tìm kiếm, phải dùng được hoàn toàn bằng bàn phím và screen reader, lọc không phân biệt dấu, và vẫn gửi id từ geo action; chưa duyệt thì giữ `<select>` gốc.
- Khối tin cậy COD cạnh nút đặt hàng: theo OD-05, chỉ dùng nội dung và link đã được owner duyệt; không tự viết cam kết thời gian giao hay điều kiện đổi trả.
- Phân biệt đã tạo, đang xử lý và kết quả đồng bộ chưa rõ; không gửi trùng, không báo thành công trước outcome xác nhận.

### UX-10 — Popup nhắc quà một lần

- Chỉ mở sau submit hợp lệ đầu khi quote/lựa chọn hợp lệ nhưng còn suất chưa chọn. Quà đã lưu invalid đi theo luồng sửa, không biến thành popup tùy chọn.
- **`canChoose=true`:** còn lựa chọn hợp lệ → **“Bạn còn quà chưa chọn”**, có **“Chọn quà ngay”** (mở picker, không submit), **“Vẫn đặt hàng”** và đóng.
- **`canChoose=false`:** phần chưa nhận không còn lựa chọn phù hợp → **“Một phần quà chưa thể nhận”**, copy trung tính theo FLOW-02; **không hiện** CTA chọn, chỉ tiếp tục/đóng. Không tự suy hết hàng hay ghi phần không thể cấp thành khách chủ động bỏ.
- **Hỗn hợp:** diễn giải riêng số còn chọn được và số chưa thể cấp; nút chọn chỉ mở phần hợp lệ.
- “Vẫn đặt hàng” là submit chủ động lần hai qua pipeline chuẩn. Đóng/Escape không submit, không xác nhận thứ ba, không reset đã nhắc vì quà/upsell/quote refresh; state UI không là permission server.
- **Nhắc ngay trên nút đặt hàng:** khi còn suất quà chọn được, hiện một dòng ngay trên nút “Đặt hàng COD”: “Bạn còn N quà chưa chọn” kèm nút “Chọn quà” (cùng hành vi mở picker như popup, không submit). Khi phần còn lại không chọn được (`canChoose=false`), chỉ hiện câu trung tính, không CTA. Dòng này chỉ để thông tin: **không** thay popup, **không** được tính là đã nhắc và **không** tạo acknowledgement không nhận quà; contract popup một lần ở trên giữ nguyên. N lấy từ model.
- Kiểm chứng khoảng chờ 350ms hiện có: giữ nếu có bằng chứng bảo vệ chống bấm nhầm; chỉ đề xuất bỏ sau test keyboard/double-submit. Không mặc định delay là bug.

## 8. Đo lường phễu — xem spec riêng

Đã tách sang [storefront-funnel-measurement-v1.md](storefront-funnel-measurement-v1.md) (MEAS-FUNNEL-001) để duyệt độc lập. Ràng buộc với spec này:
- Baseline **Mức 0** (tính được từ event và dữ liệu đơn hiện có) phải được thu **trước** khi đổi UI upsell theo B.
- Nếu owner muốn đánh giá B bằng chỉ số **Mức 1** (tỉ lệ thêm từ upsell, hoàn tất theo lượt, ma sát submit), gate MEAS-06 phải được duyệt và triển khai trước thay đổi UI.
- Duyệt spec UX này **không** duyệt sink, khóa tương quan hay định tuyến event; các AC đo lường nằm ở spec đo lường (MEAS-AC-01/02).

## 9. Acceptance Criteria — dành cho PR implementation sau khi duyệt

Các AC không là lời xác nhận feature đã chạy. AC-07 chỉ áp dụng nếu chọn A; AC-08 cho B (phương án khuyến nghị); AC-01/02 là regression của bố cục cart #177 đã merge. Các bất biến tiền/quà/submit không phụ thuộc phương án và không được bỏ.

| ID | Kịch bản | Kết quả chấp nhận |
| --- | --- | --- |
| AC-01 | Cart có GIFT achieved + GIFT progress + TIER achieved; đối chiếu mini-cart | Không CTA quà trùng trong mỗi surface; TIER/progress không mất; giá/quà đúng quote; giữ hành vi #177 đã merge |
| AC-02 | Regression bố cục cart của #177 trên `c6058a1` hoặc mới hơn; 390 và 1280/1440px | Một picker/anchor thật ở đầu trang, trước hàng mua; drawer “Chọn quà” tới đúng vùng và picker **đã mở rộng, có focus** (UX-05), không tự chọn/lưu quà; reload với hash cũng vậy; hàng mua/summary đủ. Không tách lại hai picker hoặc hồi CTA quà trùng |
| AC-03 | Entitlement 2, selected 0/1/2; thiếu lựa chọn do cấm trùng/stock chung | CTA/copy đúng số còn chọn được; không suy hết stock, không tự thêm quà |
| AC-04 | Chip-only → quay lại; nhận → bỏ thành công → quay lại | Chip-only không tăng quà; bỏ xong không draft sai; giữ quote/form/focus và draft mới nếu khách đã đổi ý định |
| AC-05 | Đủ suất vẫn xem mẫu; bỏ lỗi; giảm 2→1; mất phản hồi | Không tự swap/mất quà khác; readback và focus đúng; không gửi trùng mutation |
| AC-06 | Gợi ý theo phương án đã duyệt; dismiss/reload/quay lại; offer mất | Gợi ý tùy chọn, không flash trái intent, không chặn checkout hợp lệ; thiếu offer không hiển thị lời mời. Không mặc định baseline đã là banner |
| AC-07 | **Chỉ A:** banner `/sale` được duyệt/triển khai qua #181 hoặc PR kế tiếp; form đã nhập | Cảnh báo đúng trước exit, ở lại giữ form/focus, tiếp tục đến đúng `/sale`; không lưu PII vào storage và không hứa mọi sản phẩm tại đích đều mở ưu đãi |
| AC-08 | **Chỉ B:** gợi ý thu gọn → mở → chọn ứng viên/variant (chip) → add +1 tại checkout; 390 và 1280px | Ở mobile, gợi ý không đứng trước ô nhập đầu tiên mà nằm sau địa chỉ, trước tổng kết; trạng thái thu gọn nêu lợi ích được quote chứng minh, không dùng tên campaign làm tiêu đề. Một panel mở nhưng các mẫu hợp lệ vẫn truy cập được; delta gồm ship đúng variant, form nguyên, quà mới ở cùng checkout, khóa tới proof mới và có lý do hiện cạnh nút đặt hàng khi bị khóa |
| AC-09 | `unquotable`/quà invalid/proof thiếu ngay khi vào checkout | Lý do và hành động sửa trước form; không điền hết mới thấy disabled; không bypass proof |
| AC-10 | Giá đổi giữa render/submit (một lần và hai lần liên tiếp); refresh hoặc readback lỗi | Hiện tổng cũ → tổng mới đều từ server, cần submit chủ động, giữ form, không tạo đơn bằng quote stale; lần đổi thứ hai so với tổng của lần submit gần nhất |
| AC-11 | Form sai → sửa → submit → popup; **`canChoose=true`**, **`canChoose=false`**, hỗn hợp | Xử lý lỗi form trước; true có chọn/tiếp tục, false **ẩn chọn** và giải thích chưa thể nhận nhưng vẫn tiếp tục/đóng; hỗn hợp đúng phần hợp lệ; Escape/đóng không submit, không tự lưu chip, một lần nhắc, continuation chỉ một order. Dòng nhắc trên nút (UX-10) hiện đúng N/nhánh, không làm popup mất hay mở thêm lần, không tạo acknowledgement |
| AC-12 | Geo load/error, đổi tỉnh, retry, đã nhập ghi chú | Chỉ reset phụ thuộc, giữ giá trị độc lập, lỗi có hướng sửa sát input |
| AC-13 | 320/375/390, 768/1024, 1440px; chữ zoom 200% | Không overflow/che CTA bởi bàn phím; vùng bấm khoảng 44×44 khi khả thi; tab/focus dùng được |
| AC-14 | Scan a11y + bàn phím + screen reader trên offer/picker/popup/error | Tên/nhãn/announcement/focus return/contrast đúng; không suy tất cả đạt chỉ từ axe |
| AC-15 | Upsell timeout/stale; quà đã lưu; submit processing/unknown POS | Recommendation lỗi không cản checkout hợp lệ, không mất quà, không tự gửi lại thao tác có thể đã tạo đơn |
| AC-16 | Đối chiếu baseline thật và phần triển khai liên quan #177/#181 | Tại `main@c6058a1`, giữ test cart #177 và test inline upsell vì control còn tồn tại. Nếu chọn A, PR runtime phải thay assertion UI bằng kịch bản đã duyệt và bảo toàn coverage an toàn ở tầng phù hợp; không xóa/skip test để xanh. Với B giữ hành vi inline và bổ sung test presentation compact |
| AC-17 | Ảnh cùng fixture/viewport ở trạng thái chưa mở/đang chọn/đã lưu/lỗi | Reviewer đối chiếu thứ tự, CTA, mật độ, copy ở mobile/desktop trước sign-off; không dùng ảnh mẫu/spec thay bằng chứng runtime |
| AC-18 | Thanh dính đáy: cart nhiều dòng và checkout ở 320/375/390px; cuộn tới nút chính; mở bàn phím ở từng trường; popup mở; submit bị khóa; desktop 1280px | Thanh chỉ hiện khi nút chính ngoài màn hình, ẩn khi bàn phím/popup mở; tổng khớp quote đang hiển thị; ở checkout nút đi qua cùng pipeline submit (một order, cùng xác thực trường, cùng popup nhắc) và mang cùng trạng thái/lý do khóa; không che trường hay lỗi; không có trên desktop |
| AC-19 | Cart không cho thanh toán do 1 và nhiều dòng (hết hàng, thiếu tồn, không khả dụng) | Thông báo liệt kê đúng từng dòng với link; theo link thì tới và focus đúng dòng; dòng có nhãn chữ, không chỉ màu; lý do khớp cart model |

Dùng fixture isolated/test DB và Pancake sandbox/giả lập được phép; không tạo COD order production để nghiệm thu. Screenshot, focus và screen reader cần runtime, không suy pass từ source hoặc kết quả của PR khác.

## 10. Phạm vi triển khai sau spec và quy ước kỹ thuật

Đây là định hướng để lập kế hoạch sau phê duyệt, **không phải kế hoạch đã được duyệt hay code đã có**:
Cỡ là ước lượng tương đối để chọn đợt (S ≈ một component/ít file, M ≈ vài component hoặc có test mới đáng kể, L ≈ đổi luồng có mutation/proof hoặc nhiều bề mặt), không phải cam kết thời gian.

| Đợt | Hạng mục | Spec / AC | Cỡ | Chặn bởi |
| --- | --- | --- | --- | --- |
| 1 | Đo lường Mức 0 + business event (gồm `add_to_cart` cho add upsell) | [spec đo lường](storefront-funnel-measurement-v1.md), MEAS-AC-01 | M | — (phải chạy trước đợt 3) |
| 1 | Lý do chặn checkout hiện trước form và cạnh nút đặt hàng | UX-08, AC-09 | S | — |
| 2 | Tổng cũ → mới khi giá đổi | UX-08, AC-10 | S | — |
| 2 | Dòng nhắc quà trên nút đặt hàng | UX-10, AC-11 | S | — |
| 2 | Mở picker khi tới qua `#cart-gifts` | UX-05, AC-02 | S | — |
| 2 | Cart không cho thanh toán: liệt kê và link dòng cần xử lý | UX-08, AC-19 | S | — |
| 2 | Vòng đời trạng thái picker quà (draft, bỏ/chọn lại, focus) | UX-04/05, AC-03/04/05 | M | — |
| 3 | Upsell phương án B (vị trí, thu gọn, chip, phản hồi) | UX-06/07, AC-06/08/16 | L | OD-01; baseline Mức 0 đã thu (OD-03) |
| 3 | Thanh dính đáy mobile cart/checkout | UX-02, AC-18 | M | — (nên đi cùng/sau B vì cùng vùng nút) |
| 4 | Ô chọn phường/xã có tìm kiếm | UX-09, AC-12 | M | OD-04 |
| 4 | Khối tin cậy COD | UX-09 | S | OD-05 |
| 4 | Phí ship ở cart | UX-02 | S | OD-06 |
| 4 | Đo lường Mức 1 | MEAS-AC-02 | M | OD-02 (nếu dùng đánh giá B thì phải chạy trước đợt 3) |

Lý do thứ tự: đợt 1 lấy baseline và gỡ ma sát lớn nhất với chi phí nhỏ; đợt 2 là các sửa nhỏ, độc lập, không cần quyết định mới; đợt 3 là thay đổi lớn nhất, chỉ làm khi đã chốt OD-01 và có baseline; đợt 4 chờ quyết định nội dung/chính sách. Mỗi đợt tự nghiệm thu a11y/E2E theo AC-13/14/15/17 cho phần mình đổi; AC-07 chỉ thay AC-08 nếu OD-01 chọn A.

### Code ownership / cấu trúc

- Presentation: `src/components/brand/promotion-banner.tsx`, `cart-gift-picker.tsx`, `cart-drawer.tsx`; `src/components/commerce/checkout-upsell.tsx`, `guest-checkout-form.tsx`.
- Route/layout: `src/app/cart/page.tsx`, `src/app/checkout/page.tsx`.
- Read models: `src/routes/cart-promotion-model.ts`, `cart-gift-model.ts`, `checkout-model.ts`; chỉ bổ sung dữ liệu có nguồn authority, không tái tính tiền.
- Tracking: xem [spec đo lường](storefront-funnel-measurement-v1.md).
- Tests: `tests/a11y-runtime/cart-gift-picker.spec.ts`, `promotion-upsell.spec.ts`, `checkout-benefit.spec.ts`, `checkout.spec.ts`; domain/DB cho logic và các bất biến liên quan.
- Docs: file này và spec đo lường là đề xuất mới; amendment của spec upsell gốc được phê duyệt riêng khi quyết định thay hợp đồng, không âm thầm sửa qua runtime.

### Lệnh dành cho implementation — không phải bằng chứng đã chạy

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
```

Dùng cấu hình Playwright/workflow có thật trong repository, không giả định có `pnpm test:e2e`. Database test phải tách production. Không đổi package/version, workflow hoặc bỏ gate trong PR spec.

### Style và boundaries

Ví dụ nguyên tắc presentation: text + native control, không suy entitlement từ chuỗi:

```tsx
<button type="button" disabled={busy || !canClaim} aria-describedby={reasonId}>
  Nhận quà này
</button>
<p id={reasonId} role="status">{reasonText}</p>
```

- **Always:** một owner state/submit, semantics a11y, quote server, giữ PII trong form đang mount; test phản ánh đúng hành vi được duyệt.
- **Ask first:** A/B, thay policy/entitlement, schema/dependency/flag hoặc flow đã được owner duyệt.
- **Never:** price/stock/proof authority ở client, PII/secret trong storage/log/analytics, auto-submit sau refresh, tự đổi quà, skip test để xanh, trộn thay đổi runtime vào PR tài liệu.

## 11. Review checklist và Definition of Done

### Review checklist nội dung spec

- [ ] Hiện trạng (§3), phụ thuộc (§2), UX-06/07 và AC-01/02/06/07/08/16 nhất quán: baseline inline upsell; #181 là đề xuất banner `/sale`; #177 đã merge và là hiện trạng cart.
- [ ] Khuyến nghị B ghi rõ là khuyến nghị, không là phê duyệt; mọi điểm cần owner chốt nằm trong bảng §0; spec đo lường tách riêng, duyệt UX không ngầm duyệt sink/khóa lượt.
- [ ] Yêu cầu mới (thanh dính đáy, mở picker qua anchor, tổng cũ → mới, dòng hàng cần xử lý, dòng nhắc trên nút) không tạo submit thứ hai, không tạo acknowledgement và không tính tiền ở client.
- [ ] Giữ bảng tác động `D-03/D-04/U-02/A` và gate owner; không coi lịch sử merge là duyệt A/B.
- [ ] UX-10/AC-11 có đủ `canChoose=true/false` và hỗn hợp, giữ quyền tiếp tục/đóng, không tạo đơn ngoài ý muốn.
- [ ] Đường dẫn file, lệnh và AC đối chiếu được với source tại baseline.

### Còn cần chốt trước implementation phần tương ứng

- [ ] OD-01: owner chọn A hoặc B (spec khuyến nghị B); A cần amendment spec upsell về `D-03/D-04`, `U-02/A`, `FR-06/07/08/09/12`; B cần chốt presentation compact, vị trí mới và phối hợp kết luận #181.
- [ ] Owner chốt các dòng OD-02..OD-06 ở §0 trước khi triển khai phần mỗi dòng chặn.
- [ ] Thay đổi cart sau này đối chiếu bố cục #177 đã merge; không làm lại.
- [ ] Với A, duyệt wording/interaction rời checkout có dữ liệu; kiểm tra không mất form ngoài lựa chọn chủ động của khách.
- [ ] Implementation đạt các AC áp dụng và Definition of Done của project: test/lint/build, tích hợp, bảo mật, accessibility/runtime và tài liệu; bằng chứng chưa chạy phải ghi chưa chạy.

**Giới hạn verification:** spec này chỉ được đối chiếu với source, không chứng nhận browser, screen reader, database hoặc tính sẵn sàng production. Approve tài liệu cho phép lập kế hoạch ở phạm vi đã chốt; không tự cho phép merge #181, sửa runtime, bỏ quality gate hoặc deploy.
