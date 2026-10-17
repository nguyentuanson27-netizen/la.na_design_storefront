# Spec — Trải nghiệm ưu đãi, gợi ý mua thêm và thanh toán COD (UX-COMMERCE-001)

**Ngày:** 2026-10-17  
**Trạng thái:** DRAFT — tài liệu để owner review, chưa phê duyệt implementation  
**Baseline đã đối chiếu:** `main@7d26440c9af660c3d75117ed7ca1d561b9709c38` (sau PR #178 và PR #180, link upsell hiện dẫn `/sale`); PR #177 vẫn open, HEAD cần được kiểm tra lại khi triển khai  
**Phạm vi thay đổi của PR spec:** thêm đúng tài liệu này. Không sửa mã nguồn, test, business rules, DB, CI, dependency, feature flag hoặc deploy.

## 1. Mục tiêu, người dùng và kết quả mong muốn

Khách mua hàng thời trang trên mobile hoặc desktop cần:
1. Nhận ra **đã được giảm bao nhiêu / có quà gì / còn thiếu gì để đạt mốc**, không cần hiểu tên campaign hay cơ chế tính quote.
2. Xem và chọn quà tặng **không nhầm với hàng phải trả tiền**, không gặp CTA “Chọn quà” trùng hoặc bước lưu bị hiểu là đã hoàn tất.
3. Nhìn thấy gợi ý mua thêm **như một lựa chọn phụ, có giá trị được chứng minh**, không bị kéo khỏi luồng thanh toán ngoài ý muốn.
4. Điền thông tin, thấy tổng tiền chính xác theo báo giá hiện hành, xử lý lỗi và hoàn tất COD **không mất dữ liệu đã nhập hoặc tạo đơn trùng**.

Đây là **spec cải thiện presentation và interaction**, không viết engine ưu đãi mới. Thành công được đánh giá qua các hành vi và kịch bản AC ở §8; không tự gán chỉ tiêu tăng conversion hoặc điểm Lighthouse khi chưa có số đo.

### Giả định và điểm cần owner duyệt

- **G-01 (baseline):** PR #178 đã thay `CheckoutUpsell` thành banner gọn, không còn bộ chọn sản phẩm/size và nút thêm hàng ngay checkout; PR #180 đã merge và đổi đích CTA thành `/sale`. Đây là hiện trạng source, **không** đồng nghĩa owner đã chấp thuận thay yêu cầu upsell đã duyệt.
- **G-02 (đề xuất):** ưu tiên giữ checkout ngắn gọn, không quay lại danh sách 3–5 card mở cùng lúc. Hướng gợi ý một sản phẩm inline (nếu có) là **phương án cần phê duyệt riêng**, không là yêu cầu ngầm triển khai.
- **G-03 (phụ thuộc):** PR #177 dự kiến đưa picker lên trước hàng mua trong cart và loại banner quà đạt bị trùng; chỉ nghiệm thu bố cục đích sau khi nhánh liên quan được merge/rebase và test xanh. Không coi PR #177 đã merge.
- **G-04 (bảo toàn):** giữ toàn bộ hợp đồng quyền nhận, không nhận đủ quà, quote/proof, không tự thay quà, chống race và điều kiện POS đã duyệt ở các spec trước.
- **G-05 (approval gate):** spec upsell gốc đã ghi `D-03` (chọn biến thể và thêm trực tiếp tại checkout), `D-04` (hiển thị tối đa 3–5 mẫu) và `U-02/A` (quà mở qua upsell được chọn ngay checkout). Phương án A trong tài liệu này chỉ là baseline đang chạy, **chưa được phê duyệt thay thế** những quyết định đó; bảng UX-07 nêu phạm vi cần chốt.

## 2. Tài liệu và source of truth

| Nguồn | Vai trò |
| --- | --- |
| [gift-quantity-promotions-v1.md](gift-quantity-promotions-v1.md) | Quy tắc tặng quà, số suất, inventory, stacking, acknowledgement |
| [storefront-gift-picker-checkout-reminder.md](storefront-gift-picker-checkout-reminder.md) | Luồng picker tại cart/checkout, bỏ rồi chọn lại, popup nhắc **một lần** |
| [smart-promotion-upsell-v1.md](smart-promotion-upsell-v1.md) | Quy tắc và quyết định owner: **D-03, D-04, U-02/A, FR-07, FR-08, FR-09, FR-12** cần đối chiếu với UI mới sau PR #178/#180; không mặc định merge code là duyệt sửa spec |
| [storefront-mobile-commerce-ux.md](storefront-mobile-commerce-ux.md) | Responsive/touch/focus và thứ tự checkout mobile hiện có |
| `src/routes/cart-promotion-model.ts`, `src/routes/cart-gift-model.ts`, `src/routes/checkout-model.ts` | Quyền lợi, copy, tiền và các trạng thái có dữ liệu nguồn |
| `src/components/brand/promotion-banner.tsx`, `cart-gift-picker.tsx`, `cart-drawer.tsx` | Presentation ưu đãi và quà |
| `src/components/commerce/checkout-upsell.tsx`, `guest-checkout-form.tsx`, `src/app/checkout/page.tsx` | Banner upsell sau PR #178, form COD, summary và popup |

**Nguyên tắc ưu tiên:** business/security rules ở spec hiện hành là bất biến. Tài liệu này đề xuất UX bổ sung; điểm nào đụng một quyết định đã duyệt phải quay lại owner, không tự lặng lẽ ghi đè lịch sử. PR #178/#180 là sự thật về **code đã merge**, chưa đồng nghĩa owner đã giải quyết xung đột với spec upsell cũ.

## 3. Hiện trạng kiểm tra từ source (không phải kết quả browser)

| Bề mặt | Hiện trạng tại baseline | Hệ quả UX / cần xác minh |
| --- | --- | --- |
| PDP / listing | Thẻ sản phẩm có giá sale/badge, sản phẩm có purchase panel dùng state biến thể dùng chung | Cần kiểm tra tên ưu đãi/giá chính xác; không gộp giá Flash Sale với thưởng cart nếu không có quote |
| Mini-cart | `PromotionBanner` liên kết `/cart#cart-gifts`, hàng mua và totals trong drawer | CTA nên có đích có picker thực; không phải một nút “mở chọn” giả |
| Cart | `main` còn picker sau hàng mua; PR #177 đang đưa lên trước hàng mua | Cần duyệt bố cục cuối cùng và loại CTA GIFT achieved trùng mà vẫn giữ TIER/progress |
| Checkout | Banner ưu đãi nằm trước form; picker ở order panel; mobile có summary thu gọn; desktop order summary sticky | Dễ trùng thông báo cùng một quyền lợi khi banner, danh sách đơn và picker cùng hiện |
| Checkout upsell | PR #178 đổi widget thành banner ngắn, bỏ thêm hàng inline; PR #180 đổi “Tiếp tục mua sắm” sang `/sale` | Rời route sau khi nhập form có thể mất state; cần quyết định exit và phê duyệt thay đổi so với `D-03`/`D-04` |
| Quote không sẵn sàng | Form khóa submit nếu thiếu `quoteProof`, cảnh báo `unavailableNotice` gần vùng tổng kết cuối | Có thể thấy cảnh báo muộn sau khi nhập các trường; cần nâng thông báo đến đúng vị trí |
| Gift picker | `draft` và `selections` là hai nguồn trạng thái riêng; nhãn “chưa thêm” dựa trên `draftSaved` | Cần tái hiện trường hợp nhận rồi bỏ quà để đảm bảo không còn thông báo draft sai ngữ cảnh |

Không khẳng định các rủi ro UI trên đã tái hiện bằng browser hoặc đã xảy ra ở production. Các trường hợp phải được kiểm tra và chỉ xác nhận bug khi có bằng chứng runtime nằm ở §8.

## 4. Hợp đồng UX liên bề mặt

### UX-01 — Một quyền lợi, một thông điệp rõ ràng tại mỗi điểm hành động

- Hiển thị phân biệt **đã áp dụng giảm giá**, **đã đủ điều kiện nhận quà**, **đã thêm quà vào đơn**, **tiến độ đến mốc tiếp theo**. Không dùng “được nhận” để ngụ ý quà đã lưu.
- Tại từng vùng thao tác, **chỉ một CTA chính cho cùng hành động**. Banner được phép chứa thông tin TIER/progress, nhưng không lặp CTA “Chọn quà” khi đã có picker tương tác ngay tại đó.
- Không ẩn mất `TIER achieved` hoặc `GIFT progress` chỉ để bỏ `GIFT achieved` lặp; không ẩn lỗi/quyền lợi không khả dụng.
- Mini-cart có thể điều hướng tới `/cart#cart-gifts` nếu và chỉ nếu phía cart có picker/anchor thật tương ứng; khi không đủ quyền nhận không render lời mời nhận quà giả.
- Lấy số tiền, điều kiện đạt mốc, số suất, % và giá từ model/quote canonical; không tính từ DOM, text badge hay client.

### UX-02 — Ưu tiên việc khách đến để làm

- PDP: giá và biến thể đang mua là chính; khuyến mại là hỗ trợ quyết định, không lấn CTA mua.
- Cart: sản phẩm đang mua và quà được chọn phải phân biệt, tổng tiền rõ ràng; picker chỉ một instance. **Bố cục cart đích phụ thuộc kết quả review PR #177.**
- Checkout: ưu tiên **thông tin nhận hàng + tổng thanh toán + nút đặt COD**. Gợi ý mua thêm là tuỳ chọn, không bắt khách giải quyết để thanh toán.
- Mobile: summary luôn có thể truy cập, picker ngay sau vùng danh sách đơn kể cả lúc thu gọn (theo spec picker), không đưa cả danh sách hàng mua vào picker.
- Desktop: giữ một form workflow và order summary sticky, không mount hai controller để đổi bố cục.

### UX-03 — Nội dung ngắn, nhất quán, không tạo lời hứa sai

Ví dụ copy (chỉ là minh họa; số và khả năng chọn là dữ liệu động):
- Đủ quyền, chưa thêm: **“Bạn có 2 suất quà. Đã thêm 0/2 quà.”** CTA: **“Chọn quà”**.
- Có quà đã lưu: **“Đã thêm 1/2 quà vào đơn”**; phần chưa thể nhận có giải thích riêng.
- Hết lựa chọn hợp lệ: **“Hiện chưa có lựa chọn phù hợp cho 1 suất quà còn lại.”** Không tự nói “hết hàng” nếu giới hạn do cấm trùng mẫu/stock chung.
- Upsell: **“Thêm 1 sản phẩm phù hợp để đạt [quyền lợi được quote chứng minh]”**. Chỉ hiển thị chi phí tăng thêm khi biết biến thể và quote đáng tin.
- Lỗi báo giá: **“Giỏ hàng cần được kiểm tra lại”** + một lối thử lại/sửa tại chỗ và giữ form.

Không thêm toast/modal chỉ để lặp lại cùng status; dùng thông điệp cạnh action và một status vùng phù hợp cho screen reader.

## 5. Chọn quà — giao diện và vòng đời trạng thái

### UX-04 — Chọn / lưu / bỏ / sửa tại chỗ

- Trạng thái phân biệt **đang xem phiên bản**, **đang lưu**, **đã lưu**, **kết quả chưa rõ**; chip được chọn chưa được tính là quà của đơn.
- Một thẻ quà đang mở tại một thời điểm. Có ảnh/fallback, tên, phiên bản, tình trạng và nút **“Nhận quà này”** chỉ bật khi server model cho phép.
- Khi đã đủ suất vẫn duyệt mẫu khác được nhưng không nhận thêm; thay quà theo hợp đồng **bỏ trước, chọn lại sau**, không hứa hoán đổi nguyên tử hay tự phục hồi món đã bỏ.
- Nếu khách nhận quà rồi chủ động bỏ lại, giao diện **không được hồi sinh lời nhắc draft “chưa thêm” về chính hành động đã kết thúc**. Xác định cách clear hoặc phân biệt intent của draft sau khi bỏ thành công; chỉ clear sau kết quả đã xác nhận/readback, không xóa dự thảo mới mà khách đã chủ động chọn trong lúc đợi.
- Sau bỏ/giảm số quà, giữ focus tại nút còn hợp lệ hoặc vùng picker có tên, không đưa focus về body; không đánh dấu lỗi khi khách chủ động để trống suất.
- Khi lỗi quote/gift-invalid, cho sửa tại checkout không điều hướng làm mất thông tin nhận hàng. Trong lúc pending/unknown lock submit, upsell và thao tác quà xung đột.

### UX-05 — Rút gọn nhưng vẫn có thể quản lý

- Khi thu gọn: chỉ số quà đã lưu/còn có thể chọn/không thể cấp + một CTA phù hợp trạng thái; không trưng cả các danh sách và nút bỏ.
- Khi mở: thẻ lựa chọn và quà đã lưu có thao tác rõ; thành công/thất bại hiển thị nơi khách vừa thao tác.
- Không tự động thu gọn, điều hướng hoặc submit khi nhận đủ món cuối cùng.
- Chỉ gắn một `#cart-gifts` cho bề mặt hiện hành và một controller trạng thái.

## 6. Gợi ý mua thêm: bảo toàn trải nghiệm compact của PR #178

### UX-06 — Baseline đã merge sau PR #178/#180, không tự khôi phục UI cũ

- Giữ **banner gọn, không bắt buộc**, không phục hồi ngay danh sách dài 3–5 sản phẩm và các dropdown trên checkout.
- Không render khẳng định “thêm đúng 1 chiếc sẽ nhận quà” nếu server model không còn offer hợp lệ.
- Link hiện tại tới `/sale` là một **đường rời checkout**. Nếu khách đã nhập form, phải có xử lý UX trung thực, dễ hiểu và dùng được bằng bàn phím trước khi rời trang; mặc định đề xuất là xác nhận rời checkout sẽ làm mất thông tin chưa gửi. Không tự lưu PII vào session/local storage và không tự thêm hàng.
- Dismiss chỉ ẩn đề xuất trong vòng đời đã duyệt; không ẩn picker/quyền nhận đã có, không reset quote/submit hoặc khóa đơn.

### UX-07 — Quyết định sản phẩm phải được owner phê duyệt tường minh

**Mâu thuẫn đã xác nhận:** `smart-promotion-upsell-v1.md` quy định `D-03` chọn biến thể và thêm đúng 1 chiếc **tại checkout**, `D-04` hiển thị tối đa 3–5 mẫu hợp lệ; `U-02/A` đã được owner duyệt về việc chọn quà do upsell mở **ngay checkout**. `FR-07/08/09/12` chi tiết hóa giá/variant, thêm hàng, quà và accessibility. PR #178 đã bỏ UI thêm inline; PR #180 chỉ đổi đích banner sang `/sale`. **Hai PR merge không thay thế được approval nghiệp vụ.**

**Phương án A — ghi nhận hiện trạng, CHƯA được owner duyệt thay yêu cầu:** banner gọn, nút “Tiếp tục mua sắm” đến `/sale`. Khi form đã nhập, đề xuất cảnh báo trước khi rời; chọn ở lại giữ nội dung/focus. `/sale` là trang bán hàng, **không được hứa** rằng chỉ hiển thị ứng viên đã được server chứng minh hay cho thêm +1 ngay checkout. Chọn A đòi hỏi owner chủ động chấp thuận việc thay thế `D-03`, `D-04` và hành trình unlock gift của `U-02/A` (không bỏ picker gift của checkout).

**Phương án B — chỉ khi owner duyệt:** giữ banner nhỏ, mở phần inline **một ứng viên mỗi lần**, có ảnh/tên, lựa chọn variant, giá và chênh lệch tổng thanh toán **được server quote xác minh**, add đúng +1 qua action/proof hiện có. Vẫn truy cập được tập tối đa 5 mẫu hợp lệ bằng danh sách thu gọn, không mở nhiều form. Sau add có quà mới, picker tại checkout hiện ngay, giữ dữ liệu nhận hàng và khóa submit đến quote mới. Không viết engine định giá hay auto-add.

| Yêu cầu/decision đang được ghi nhận | A — banner tới `/sale` | B — inline compact | Phê duyệt/cập nhật bắt buộc |
| --- | --- | --- | --- |
| **`D-03`**: variant + add trực tiếp ở checkout | **Không đáp ứng** | Giữ hành vi, đổi cách trình bày | Chọn A phải được owner phê duyệt thay `D-03` |
| **`D-04`, `FR-06`**: trình bày 1–5 mẫu hợp lệ | **Không đáp ứng phần hiển thị**; banner không có card | Tối đa 5 mẫu truy cập được, một card mở | Chọn A phải được owner phê duyệt sửa `D-04`/UI của `FR-06` |
| **`FR-07/08/12`**: variant/estimate, thêm an toàn tại checkout, a11y | **Không đáp ứng phần tương tác inline** | Giữ logic/proof và UX inline compact | A cần phê duyệt thay flow; B không được nới proof/stock |
| **`U-02/A`, `FR-09`**: unlock gift → chọn tại checkout | Mua thêm qua `/sale` đổi hành trình; picker tại checkout vẫn phải cho chọn mọi quà hợp lệ sau khi quay lại | Giữ add → unlock → chọn quà ngay checkout | A cần owner phê duyệt thay hành trình **không được bỏ picker checkout** |
| **`D-01/02/05/07/08`, `U-01/A`, `FR-04/05`**: cơ hội, quote, cost, tồn kho | Giữ policy server để phát offer; banner không đưa ra cost/variant không có bằng chứng | Giữ policy server cho cả lựa chọn và mutation | Không sửa pricing/campaign/stacking/stock authority |
| **`D-06`, `FR-10/11`**: dismiss và lỗi | Giữ | Giữ | Không reset state sai lượt hoặc auto-retry |

**Decision gate:** owner phải chọn **A hoặc B tường minh** trước `/plan` hoặc `/build`. Nếu chọn A, có amendment/supersession cho `docs/specs/smart-promotion-upsell-v1.md` ghi rõ `D-03/D-04`, `U-02/A`, `FR-06/07/08/09/12`, luồng đến `/sale` và regression tests; **chưa cập nhật/chưa duyệt thì không coi A đáp ứng spec gốc**. Nếu chọn B, chốt compact inline và tài liệu hóa vì sao khôi phục tương tác bị bỏ sau PR #178, không âm thầm đảo thay đổi đã merge.

## 7. Checkout COD — hỗ trợ hoàn thành và sửa lỗi

### UX-08 — Trạng thái checkout chưa sẵn sàng phải thấy sớm

- Nếu route `unquotable`, thiếu proof, quà invalid hoặc có lỗi nguồn địa chỉ nghiêm trọng, thông báo có đường xử lý phải xuất hiện **trước dãy trường nhập**; đồng thời có ngữ cảnh cạnh tổng kết/submit khi cần.
- Không đưa lý do chung “chưa thể đặt hàng” rồi để CTA disabled không giải thích. Nếu còn cách sửa ngay (quà invalid, cập nhật báo giá, chọn địa chỉ lại), ưu tiên thao tác tại chỗ.
- Chỉ nâng thông báo UI, không tự phát hành proof mới, không cho submit khi state chưa hợp lệ.
- Khi price/stock/ship thay đổi, chỉ hiển thị số mới từ quote; cần một hành động submit/xác nhận **chủ động** mới, không tự tiếp tục sau refresh.

### UX-09 — Cách tổ chức giao hàng và tổng kết

- Mobile: thông tin đơn có thể thu gọn, nhưng khách luôn nhìn thấy tổng thanh toán trước nút đặt hàng; vùng quà không bị ẩn bên trong summary đóng.
- Desktop: giữ một summary sticky ở cột phụ và một form thông tin; đọc theo thứ tự hợp lý bằng keyboard/screen reader.
- Trường tên, số điện thoại, tỉnh/thành, phường/xã, địa chỉ, ghi chú có nhãn, autocomplete phù hợp, lỗi sát trường và focus vào trường lỗi đầu khi submit sai.
- Khi đổi tỉnh/thành, chỉ reset địa chỉ phụ thuộc thật sự; nếu geo read lỗi phải có nút thử lại mà **không xóa tên/SĐT/địa chỉ chi tiết/ghi chú đã nhập**.
- Đơn đã tạo, đang xử lý hoặc kết quả đồng bộ chưa rõ: trạng thái riêng, không cho gửi trùng; không gọi “đặt thành công” trước khi có outcome xác nhận.

### UX-10 — Popup nhắc quà một lần

- Chỉ mở sau lần submit hợp lệ đầu tiên khi quote/lựa chọn quà hợp lệ nhưng còn suất chưa chọn. Quà đã lưu bị invalid đi theo luồng sửa tại chỗ, không bị chuyển thành popup tùy chọn.
- **`canChoose=true`:** còn lựa chọn hợp lệ → tiêu đề **“Bạn còn quà chưa chọn”**, có **“Chọn quà ngay”** (mở picker, không submit), **“Vẫn đặt hàng”** và nút đóng.
- **`canChoose=false`:** toàn bộ suất chưa nhận không còn lựa chọn phù hợp → tiêu đề **“Một phần quà chưa thể nhận”**, giải thích trung tính theo FLOW-02; **không hiện** CTA “Chọn quà ngay”, chỉ “Vẫn đặt hàng” và đóng. Không tự suy “hết hàng”, không tính suất không thể cấp là khách chủ động bỏ.
- **Trường hợp hỗn hợp:** còn phần được chọn và phần không thể cấp → thông báo riêng `selectable` và phần chưa thể cấp; nút chọn chỉ mở những lựa chọn hợp lệ.
- “Vẫn đặt hàng” là submit chủ động lần hai qua pipeline chuẩn. Đóng/Escape không submit, không tạo xác nhận thứ ba, không reset “đã nhắc” vì quà/upsell/quote refresh; state UI không là permission server.
- Kiểm chứng khoảng chờ 350ms hiện có trước nút “Vẫn đặt hàng”: nếu bảo vệ chống bấm nhầm có bằng chứng thì giữ; nếu chỉ tạo trì hoãn vô cớ, đề xuất bỏ **sau** test keyboard/double-submit. Không mặc nhiên coi delay là bug.

## 8. Acceptance Criteria (AC) — bắt buộc trước merge PR implementation

| ID | Kịch bản | Kết quả chấp nhận |
| --- | --- | --- |
| AC-01 | Cart có GIFT achieved + GIFT progress + TIER achieved cùng lúc; so với mini-cart | Ở mỗi surface không có CTA quà trùng; TIER và progress không mất; giá và quà đều do quote |
| AC-02 | PR #177 được merge/rebase, viewport 390 và 1280/1440 | Một picker/anchor thật, đứng vị trí đã duyệt; drawer link mở được bề mặt đó; hàng mua và summary vẫn đủ |
| AC-03 | Có entitlement 2, selected 0/1/2 và thiếu lựa chọn do cấm trùng/stock chung | Copy và CTA đúng phần còn có thể nhận, không suy hết stock từ count; không tự thêm quà |
| AC-04 | Chọn size chỉ để xem → quay lại; nhận thành công → bỏ thành công → quay lại | Chip-only không tăng quà; sau bỏ không còn draft báo sai; quote/form/focus giữ đúng |
| AC-05 | Đã đủ suất, duyệt mẫu khác, thử bỏ, bỏ lỗi, giảm 2→1 hoặc kết quả chưa rõ | Không tự swap, không mất quà khác, có readback và focus đúng, không gửi trùng mutation |
| AC-06 | Checkout có banner upsell; skip/reload/quay lại; không có offer an toàn | Banner phụ có thể bỏ; không flash lại trái intent, không cản checkout; thiếu offer thì không hiển thị |
| AC-07 | Banner dẫn `/sale` sau khi điền form | Trước khi rời có thông tin trung thực về mất dữ liệu, chọn ở lại giữ form và focus; không lưu PII trong storage |
| AC-08 | **Chỉ nếu owner chọn B:** chọn 1 ứng viên/variant và add +1 ngay checkout | Một panel mở, quote delta gồm ship đúng variant, form nguyên, gift mới xuất hiện ở cùng checkout, lock tới proof mới |
| AC-09 | Checkout `unquotable`/quà không hợp lệ/proof thiếu ngay lúc mở | Trước form có lý do và hành động sửa, không ép khách điền xong mới biết disabled; không bypass proof |
| AC-10 | Giá đổi giữa render và submit; quote refresh/thất bại readback | Số tiền mới xuất hiện rõ; cần xác nhận/submit chủ động; giữ form, không phát order khi quote stale |
| AC-11 | Gift reminder: form sai → sửa → submit → popup; kiểm **`canChoose=true`**, **`canChoose=false`** và hỗn hợp | Form lỗi phải xử lý trước; true hiện chọn/tiếp tục, false **ẩn CTA chọn** + giải thích chưa thể nhận nhưng cho tiếp tục/đóng, hỗn hợp mời chọn đúng phần hợp lệ; Escape/đóng không submit, không tự lưu chip, chỉ nhắc một lần và continuation chỉ một order |
| AC-12 | Geo load/error; change province; checkout retry; note đã nhập | Trường phụ thuộc reset đúng, các giá trị độc lập vẫn giữ, lỗi có hướng sửa gần input |
| AC-13 | Mobile 320/375/390, tablet 768/1024, desktop 1440, text zoom 200% | Không overflow, không che CTA bằng bàn phím, 44×44 touch target khi thực tế khả thi, một luồng tab/focus có thể dùng |
| AC-14 | WCAG scan + bàn phím + screen reader thủ công trên offer/picker/popup/error | Có tên control, nhãn, announcement, focus return, contrast; không chỉ dựa trên axe |
| AC-15 | Upsell timeout/offer mất/stale; cart gift saved; checkout submit đang xử lý/unknown POS | Recommendation fail không chặn checkout hợp lệ; không mất quà; không gửi lại request có thể đã tạo đơn |
| AC-16 | Regression về PR #178 và PR #177 | Test browser phản ánh **UI thực đã merge**; không giữ test dropdown inline như còn hoạt động khi chọn A; không làm xanh bằng skip/xóa test |
| AC-17 | Ảnh chụp cùng dữ liệu/viewport ở trạng thái mới/đang chọn/đã lưu/lỗi | Reviewer đối chiếu đúng order, CTA, mật độ, copy và mobile desktop trước sign-off |

**Test dữ liệu thật:** dùng fixture isolated/test DB và giả lập Pancake phù hợp; không tạo COD order trên production để nghiệm thu. Các AC về screenshot, focus và screen reader là bằng chứng runtime; đọc code không đủ.

## 9. Tổ chức triển khai dự kiến (không phải kế hoạch đã duyệt)

Gợi ý các lát cắt sau khi owner approve spec:
1. **Slice A — Trạng thái và lỗi có thể gây hiểu nhầm:** UX-04/08, AC-04/09/10; đảm bảo source-truth và regression.
2. **Slice B — Ưu đãi/cart/picker thống nhất:** UX-01/02/03/05, AC-01/02/03/05; phụ thuộc PR #177 được xử lý.
3. **Slice C — Checkout upsell sau quyết định A hoặc B:** UX-06/07, AC-06/07 và AC-08 nếu áp dụng. Không ngầm phục hồi UI đã bỏ ở PR #178.
4. **Slice D — Polish và E2E end-to-end:** UX-09/10, AC-11..17; snapshot mobile/desktop và CI.

Không tách PR implementation theo số file tùy tiện; mỗi slice có test và bằng chứng của riêng mình. Trước `/build` phải chốt UX-07 A/B và thứ tự phụ thuộc PR #177.

### Code ownership / cấu trúc

- Presentation: `src/components/brand/promotion-banner.tsx`, `cart-gift-picker.tsx`, `cart-drawer.tsx`; `src/components/commerce/checkout-upsell.tsx` và `guest-checkout-form.tsx`.
- Route/layout: `src/app/cart/page.tsx`, `src/app/checkout/page.tsx`.
- Pure read models: `src/routes/cart-promotion-model.ts`, `cart-gift-model.ts`, `checkout-model.ts` — chỉ sửa khi UI cần dữ liệu mới đã được authority cung cấp; không tái tính tiền.
- Tests: `tests/a11y-runtime/cart-gift-picker.spec.ts`, `promotion-upsell.spec.ts`, `checkout-benefit.spec.ts`, `checkout.spec.ts`; domain/DB khi logic bất biến thực sự có thay đổi.
- Docs: spec này là hồ sơ quyết định mới; sau khi duyệt/triển khai phải đồng bộ chỗ mâu thuẫn với upsell spec cũ.

### Lệnh đối chiếu (chỉ dành cho implementation; chưa chạy trong PR spec)

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

Dùng các Playwright specs/workflow có thật trong repository; không giả định có `pnpm test:e2e`. Test DB chỉ chạy trong môi trường test riêng.

### Style và boundaries

Ví dụ nguyên tắc trình bày trạng thái: dùng text + native control, không suy entitlement từ text:

```tsx
<button type="button" disabled={busy || !canClaim} aria-describedby={reasonId}>
  Nhận quà này
</button>
<p id={reasonId} role="status">{reasonText}</p>
```

- **Always:** một owner cho state/submit, a11y semantics, quote model từ server, giữ PII trong form state đang mount, cập nhật test/screenshot cho behavior thực.
- **Ask first:** chọn UX-07 A/B, thay đổi policy/entitlement, bổ sung schema/dependency/feature flags, thay đổi flow checkout đã được duyệt.
- **Never:** chuyển price/stock/entitlement/proof authority sang client, lưu PII/secret vào storage/log, auto-submit khi refresh, tự thay quà, bỏ test đỏ chỉ để CI xanh, thay đổi checkout/POS contract khi chưa phê duyệt.

## 10. Review checklist và quyết định còn mở

- [ ] Owner xác nhận **UX-07: A (banner đến `/sale`, đề nghị thay `D-03/D-04`) hay B (compact inline một ứng viên)**. Nếu A, phải duyệt amendment của spec upsell gốc về `D-03`, `D-04`, `U-02/A`, `FR-06/07/08/09/12` trước khi coi implementation đáp ứng.
- [ ] Owner xác nhận bố cục cart sau PR #177: picker ở trên hàng mua và không lặp GIFT achieved CTA.
- [ ] Reviewer thống nhất vị trí và wording của cảnh báo rời checkout có form đã nhập.
- [ ] Owner chấp thuận rằng “sửa trạng thái/source-truth trước, polish sau” là ưu tiên; không thay policy tính giá.
- [ ] Kiểm tra CI hiện tại của `main`/PR #177 khi bắt đầu triển khai; **PR spec không xác nhận test runtime**.

**Exit gate cho PR tài liệu:** chỉ 1 file Markdown mới; đủ mục tiêu, hiện trạng/baseline, xung đột và quyết định mở, UX contract, AC testable, lệnh/thư mục/style/boundaries; đường dẫn tham chiếu tồn tại; không tự nhận đã chạy browser/build/DB/CI. Việc approve spec mới cho phép vào /plan, không tự cho phép merge code hay deploy.
