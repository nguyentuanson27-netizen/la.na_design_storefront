# Spec — Chọn quà gọn hơn và nhắc một lần khi đặt hàng

**Project:** La.na Design Storefront
**Ngày:** 16/10/2026
**Trạng thái:** Spec và UX-01..UX-04 đã được owner duyệt qua PR #173/#174. Implementation theo yêu cầu ngày 16/10/2026 nằm ở PR #175; đang nghiệm thu, chưa phát hành.
**Baseline đã đối chiếu:** `main@e08715493c224a76e078d4c42b2565294e493d0d`.
**Phạm vi PR #174:** Cập nhật đặc tả UX cùng plan/checklist. Không sửa giao diện, logic đặt hàng, database, cấu hình hoặc dependency; không triển khai tính năng.

## 1. Mục tiêu và phạm vi

Khách thấy quà được nhận ngay dưới danh sách sản phẩm, chọn quà bằng ảnh và thao tác ngắn, không phải đọc biểu mẫu dài hoặc xem lại hàng đang mua. Khách được quyền đặt đơn khi chưa chọn đủ quà, nhưng được nhắc một lần trước khi tiếp tục.

Yêu cầu đã chốt:

1. Không list lại sản phẩm đang mua bên trong khu vực chọn quà. Danh sách quà có thể chọn và quà đã chọn vẫn cần hiển thị.
2. Bỏ khối diễn giải không nhận quà và checkbox xác nhận đang nằm sau phần ghi chú, gần tổng tiền trong ảnh phản hồi. Không xóa các dòng tổng giá trị, giảm giá, vận chuyển hoặc tổng thanh toán.
3. Đặt lời nhắc chọn quà ngay dưới danh sách sản phẩm trong giỏ/checkout.
4. Nếu khách còn quà chưa chọn và bấm đặt hàng: lần đầu hiện popup nhắc; nếu khách vẫn bấm đặt hàng lần hai thì không nhắc lại, tiếp tục luồng đặt hàng bình thường.
5. Tổng hợp thiết kế đã trao đổi: thẻ ảnh thay dropdown sản phẩm, tiến độ ngắn, mở tùy chọn khi cần, tổng kết quà rõ ràng, phong cách nâu–kem hiện có.

“Đặt hàng bình thường” không có nghĩa là bỏ qua xác thực địa chỉ, giá, tồn kho, quyền nhận quà, quote proof, chống đặt trùng hoặc kết quả POS chưa rõ. Chỉ bỏ lần nhắc quà lặp lại; chỉ báo thành công sau khi hệ thống xác nhận đơn.

Không thuộc phạm vi: thiết kế lại toàn bộ checkout, thay luật tính khuyến mại/ship/giá, tự chọn hoặc tự thay quà, thay hợp đồng Pancake, carousel, hiệu ứng ăn mừng, bộ chọn nhiều popup, hoặc xóa chức năng gợi ý mua thêm độc lập. Bản này không yêu cầu API đổi quà nguyên tử, lưu nháp thông tin nhận hàng vào database/browser storage, thư viện state mới hoặc bộ mockup độ chi tiết cao riêng.

## 2. Quan hệ với spec cũ và mặc định cần review

Đây là bản bổ sung cho [gift-quantity-promotions-v1.md](gift-quantity-promotions-v1.md), đặc biệt FR-06 và phần trình bày cart/checkout của FR-11. Sau khi spec này được duyệt, thao tác đặt hàng chủ động lần hai sau lời nhắc thay thế checkbox xác nhận. Không sửa ý nghĩa chọn từ 0 đến `entitled`, không tự thay quà và không chuyển quyền chưa nhận thành nợ quà. Giữ tài liệu cũ làm lịch sử; khi triển khai phải cập nhật các tham chiếu/checklist còn mô tả checkbox bắt buộc.

Các mặc định dưới đây ban đầu được đề xuất để review và đã được duyệt cùng spec qua yêu cầu merge PR #173; không coi đó là các xác nhận riêng trước thời điểm merge:

- **R-01 — Phạm vi một lần:** một lượt checkout của cùng giỏ trong cùng tab; không reset vì render lại, refresh quote, đổi lựa chọn quà, mua thêm trong cùng lượt hoặc lỗi gửi đơn. Tải lại cùng lượt được khôi phục bằng trạng thái UI theo tab khi storage khả dụng. Rời checkout kết thúc lượt, đơn thành công/giỏ được xóa hoặc đổi sang giỏ khác bắt đầu lượt mới. Không lưu “đã nhắc” vĩnh viễn theo khách.
- **R-02 — Đếm lần bấm:** xét lần submit hợp lệ về các trường bắt buộc, không phải bộ đếm mọi click. Popup có nút “Chọn quà ngay” và “Vẫn đặt hàng”; nút thứ hai chính là lần đặt hàng thứ hai, không thêm bước xác nhận thứ ba. Đóng popup rồi bấm nút đặt hàng của form cũng là lần tiếp tục hợp lệ.
- **R-03 — Chọn thiếu và phần không thể cấp:** áp dụng cả chưa chọn món nào và chọn một phần. Phần không thể cấp có thể do tồn kho, giới hạn mẫu không trùng hoặc các giới hạn lựa chọn hợp lệ khác. Không suy “hết hàng” chỉ từ `shortForStock`/`unavailableSlots`; nội dung và CTA theo UI-02/FLOW-02, không quy phần này thành khách tự bỏ quà.
- **R-04 — Bộ chọn tại chỗ:** dùng cùng bộ chọn cho cart và checkout. Tại checkout phải mở được mà không điều hướng về `/cart`, kể cả khi đang sửa lựa chọn quà mất hiệu lực theo DATA-03, để giữ thông tin nhận hàng và ghi chú.

Bản sửa sau review chọn hợp đồng đơn giản **bỏ rồi chọn lại** tại UI-04, không hứa đổi nguyên tử hoặc tự khôi phục quà cũ. Bố cục theo trạng thái và mẫu sắp xếp mobile/desktop tại UI-06 được duyệt cùng PR spec; không cần một vòng duyệt bộ mockup riêng để bắt đầu implementation.

Phê duyệt PR spec là checkpoint để chốt các mặc định này trước implementation. Không tự diễn giải “đã mở popup” thành xác nhận đặt đơn.

**Bổ sung sau review PR #174:** UX-01 phân biệt phiên bản đang xem với quà đã lưu; UX-02 nối đường quay lại thanh toán; UX-03 làm rõ xem trước/bỏ/chọn lại; UX-04 phân vai danh sách đơn và bộ chọn thu gọn. Hợp đồng được cập nhật ngay tại UI-04..UI-06/FLOW-02 và AC-25..AC-28, không đợi T13. Quyết định tiếp thu và task chịu trách nhiệm nằm ở mục “Tiếp thu review UX” của [plan](../../tasks/storefront-gift-picker-checkout-reminder-plan.md). Đây là bản sửa tài liệu để duyệt, không phải kết quả browser hoặc phê duyệt implementation. Tên nút/câu ví dụ mới có thể diễn đạt tương đương nếu giữ đúng ý nghĩa và kết quả nghiệm thu.

## 3. Hiện trạng đã đối chiếu trong repository

| Nguồn | Hiện trạng liên quan |
|---|---|
| `src/components/brand/cart-gift-picker.tsx` | Dropdown sản phẩm, danh sách biến thể dạng dòng, nhiều chỉ số và chưa có ảnh; có `#cart-gifts`. |
| `src/routes/cart-gift-model.ts` | Có campaign, quyền nhận, lựa chọn, nhãn biến thể và tồn kho; chưa có ảnh. Có phân biệt `earned`, `entitled`, phần chưa chọn và thiếu lựa chọn hợp lệ. |
| `src/components/headless/use-cart-gifts.ts` | Lưu theo từng thao tác nhận/bỏ quà; có pending và thông báo kết quả. |
| `src/app/cart/page.tsx` | Bộ chọn nằm trong aside tổng kết, không ngay sau danh sách hàng mua. |
| `src/app/checkout/page.tsx` | Danh sách đơn có bố cục mobile/desktop; dòng mua có thể tách theo đơn giá, dòng quà được phân biệt. Nhánh không `ready` không render form checkout. |
| `src/components/commerce/guest-checkout-form.tsx` | `ackMissing` chặn submit; checkbox `nonclaimAcknowledged` được gắn với `benefit.digest`; khối quyền lợi nằm sau ghi chú. Thông tin nhận hàng ở state cục bộ; ghi chú là textarea không controlled. |
| `src/components/commerce/checkout-upsell.tsx` | Bộ chọn bị lọc theo `attempt.giftIds` sau mua thêm; không phải lối chọn tất cả quyền nhận sẵn có. |
| `src/routes/checkout-model.ts` | `CheckoutBenefitView.slots` có `entitled`, `selected`, `unclaimed`, `skippedWhileAvailable`, `shortForStock`; `buildBenefitUnavailableCheckoutViewModel()` trả `unquotable`, `benefit: null`, `quoteProof: null` cho `GIFT_SELECTION_INVALID`. |
| `src/commerce/cart-gift-selection.ts` | `set()` thay một dòng theo campaign + variant, không thay variant khác. `quantity: 0` là bỏ chủ động, được phép khi campaign/giỏ stale; thêm quà kiểm tra toàn bộ tập lựa chọn. |
| `src/commerce/gift-quantity-entitlement.ts`, `tests/domain/cart-gift-model.test.ts` | `unfulfillableForStock` bao gồm thiếu tồn hoặc thiếu mẫu khác nhau; đã có fixture còn 10 chiếc, chỉ một mẫu, cấm trùng và được hưởng hai suất. |
| `src/commerce/guest-checkout-public-actions.ts` và `guest-checkout-submit-runtime.ts` | Nhận literal `nonclaimAcknowledged=yes`; server chỉ cấp acknowledgement sau khi quote proof khớp với quote tính lại. |

Đây là nhận xét từ mã nguồn và ảnh người dùng, không phải kết quả chạy browser. Không kết luận mọi danh sách sản phẩm trong checkout là bản sao: các paid price segment khác đơn giá vẫn phải giữ nguyên. Các khoảng trống được bổ sung sau review là hợp đồng cho implementation, không phải hồi quy runtime do PR tài liệu này gây ra.

## 4. Giao diện và chọn quà

### UI-01 — Một khu vực quà, vị trí theo bề mặt

Cart (cập nhật theo phản hồi người dùng 2026-10-17): đặt **bộ chọn quà đang hoạt động trước danh sách hàng mua**, ngay đầu cột nội dung dưới tiêu đề Giỏ hàng, trên cả mobile và desktop. Dòng banner thông báo quà đã đạt cùng liên kết chỉ cuộn `#cart-gifts` không được hiển thị lần hai trên trang Cart: chính bộ chọn phải hiển thị tiến độ và nút mở lựa chọn. Vẫn giữ thông báo ưu đãi giảm giá và tiến độ hướng tới mốc tiếp theo của banner nếu có, giữ một controller/ID `cart-gifts`, không tạo bản sao ở dưới danh sách. Liên kết quà từ mini-cart vẫn có thể điều hướng về bộ chọn trên trang Cart.

Checkout: lời nhắc nằm ngay sau vùng danh sách đơn; không để sau địa chỉ/ghi chú hoặc chen giữa các dòng tổng tiền. Thay đổi vị trí trên Cart không thay đổi hành trình popup và giữ form ở Checkout.

Lời nhắc và bộ chọn mở rộng là cùng một khu vực. Khi danh sách đơn trên mobile thu gọn, lời nhắc vẫn nhìn thấy ngay sau vùng thu gọn đó; không bắt khách mở danh sách mới biết có quà. Trên desktop giữ cấu trúc checkout hiện có, chỉ điều chỉnh vị trí/điểm gắn của khu vực quà.

Chỉ có một bộ chọn tương tác hoạt động và một owner cho trạng thái nhắc/submit. Không mount hai controller độc lập cho hai breakpoint, không trùng ID `cart-gifts`, không lồng form. Lời nhắc không phụ thuộc khách đã mua thêm, `attempt.giftIds`, hoặc bật/tắt gợi ý upsell. Không làm mất quyền chọn khi khách bỏ qua đề xuất mua thêm.

### UI-02 — Nội dung ngắn và đúng trạng thái

Trường hợp bình thường:

> **Quà dành cho bạn**
> Bạn còn **{N} món quà chưa chọn**.
> Chọn quà để nhận đủ ưu đãi của đơn hàng.
> **Chọn quà ngay**

Trong trường hợp bình thường, `N` là số chưa chọn và còn có thể cấp từ kết quả xác thực. Khi có phần không thể cấp, tách **số còn có thể chọn** và **số chưa thể cấp** bằng dữ liệu server/engine; không dùng toàn bộ `unclaimed` trong lời mời nhận ngay. Không hard-code, không suy từ số hàng đang mua hoặc tổng stock trên thẻ. Giữ chi tiết theo campaign khi nhiều chương trình có quy tắc khác nhau.

Với phần không thể cấp, mặc định dùng: **“Hiện chưa có lựa chọn phù hợp cho {U} suất quà còn lại.”** Chỉ nói “không đủ hàng” khi nguồn dữ liệu chứng minh đúng nguyên nhân đó; `shortForStock`, `unfulfillableForStock` hoặc `unavailableSlots` tự chúng không chứng minh hết tồn kho. Khi đã xác định giới hạn không trùng, có thể thêm “Mỗi mẫu được chọn 1 lần.” Không dựng hệ thống phân loại nguyên nhân mới chỉ để thay câu chữ; câu trung tính là fallback đủ dùng.

Chỉ hiện CTA nhận thêm khi thực sự còn lựa chọn hợp lệ. Nếu không thể nhận thêm nhưng đã có quà được chọn, vẫn cho xem/bỏ các món đó. Không dùng “đã chọn đủ” chỉ vì hết lựa chọn trong khi `selected < entitled`; hiển thị tổng kết và thông báo phần không thể cấp. Lỗi quà đã chọn mất hiệu lực là trạng thái cần sửa, không phải phần chưa chọn không thể cấp.

Khi chọn đủ và lựa chọn hợp lệ: ẩn lời nhắc, giữ tổng kết ngắn và **“Xem quà đã chọn”**; hành động bỏ/chọn lại tuân theo UI-04. Không có quyền nhận và không có lựa chọn cũ cần xử lý: ẩn toàn bộ khối. Lựa chọn cũ không hợp lệ vẫn phải hiện hướng xử lý dù quyền hiện tại bằng 0 hoặc quote đang không tạo được; giữ form theo DATA-03.

Bỏ khối checkbox trong ảnh, `ACK_MISSING_MESSAGE` và lỗi yêu cầu tích checkbox khi thay luồng. Không xóa `tierNotice` về thay đổi ưu đãi chỉ vì nó đang chung container; đưa thông báo còn cần thiết tới vùng tổng kết/phản hồi phù hợp.

### UI-03 — Thẻ quà bằng ảnh

Thay dropdown sản phẩm bằng thẻ có ảnh thật, tên và trạng thái. Mobile ưu tiên thẻ ngang; màn hình rộng có thể hai cột khi đủ chỗ. Không list lại hàng mua, không copy cả order summary vào bộ chọn. Gợi ý mua thêm phải tách rõ khỏi quà miễn phí.

Bổ sung ảnh ở nguồn dữ liệu và model quà, dùng cơ chế media tin cậy sẵn có, có fallback khi thiếu ảnh. Không đoán URL ảnh, không đưa URL tùy ý từ client vào fetch phía server. Dùng cùng tỷ lệ ảnh, có kích thước để tránh nhảy bố cục.

### UI-04 — Chọn mẫu, chọn phiên bản, nhận quà và chọn lại

Luồng: chọn mẫu quà → mở tùy chọn của mẫu đó → chọn phiên bản hợp lệ → “Nhận quà này”. Chỉ mở chi tiết một mẫu tại một thời điểm. Món chỉ có một lựa chọn hợp lệ không cần thêm một bước chọn lựa chọn duy nhất, nhưng vẫn phải có hành động nhận quà chủ động.

Hiện tại có thể dùng `option.label` làm chip. Chỉ tách màu/size khi dữ liệu thuộc tính rõ ràng; không cắt chuỗi để đoán. Thao tác chọn chip chưa ghi nhận quà; nút nhận mới gọi cơ chế lưu hiện có. Giữ lưu theo từng thao tác, không thêm “Lưu tất cả”.

**UX-01 — Phiên bản đang xem khác quà đã thêm.** Ba trạng thái phải phân biệt bằng chữ/nhãn, không chỉ màu:

| Trạng thái | Phản hồi bắt buộc |
|---|---|
| Chưa thêm | Chip/phiên bản có thể được đánh dấu đang xem nhưng có dòng “Chưa thêm vào đơn”; không mang nhãn thành công, không tăng số quà trong đơn. Nút nhận vẫn dễ thấy khi được phép nhận. |
| Đang thêm | Hiện trạng thái chờ, khóa thao tác xung đột; giữ số lượng đã lưu gần nhất, không tăng lạc quan. |
| Đã thêm | Chỉ sau xác nhận lưu hoặc readback xác định thành công mới đổi tổng kết/số lượng và báo “Đã thêm vào đơn” kèm món/phiên bản. Nếu quote còn refresh, đặt hàng vẫn khóa theo DATA-03. |

Kết quả chưa rõ không được gọi là thành công hoặc thất bại chắc chắn: hiển thị đang kiểm tra và readback theo hợp đồng bên dưới. Lỗi giữ ngữ cảnh để thử lại sau khi kết quả đã xác định. Phiên bản đang xem chưa nhận không được âm thầm xóa dấu hiệu khi thu gọn/quay lại thanh toán; ở vùng thanh toán phải còn thông báo ngắn, không chặn, ví dụ “Phiên bản {label} chưa được thêm. Đơn chỉ gồm quà đã lưu.” Thông báo không phải lỗi form hoặc bước xác nhận mới. Lần submit chủ động sau nhắc vẫn được tiếp tục với quà thực sự đã lưu nếu các kiểm tra khác đạt; không tự lưu chip, không thêm popup thứ ba.

Quà đã chọn có ảnh nhỏ, tên, phiên bản, số lượng khi cần và thao tác bỏ/chọn lại rõ nghĩa trong phần quản lý mở rộng theo UI-06. Giảm số lượng vẫn khả dụng khi chương trình cho nhận nhiều chiếc cùng mẫu và tập lựa chọn sau giảm hợp lệ.

**Hợp đồng v1: bỏ rồi chọn lại, không đổi trực tiếp.** “Xem quà đã chọn” mở phần quản lý: các quà đã lưu, thao tác bỏ/chọn lại và đường xem lựa chọn khác; không ghi dữ liệu. Với dòng một chiếc, dùng nút **“Bỏ quà để chọn lại”** và lời phụ ngay cạnh, thấy trước khi bấm: “Quà cũ sẽ được bỏ trước. Món chọn lại tùy tình trạng còn hàng.” Cảnh báo và nút dài nằm trong phần quản lý mở rộng, không trải cạnh mọi món khi thu gọn. Không gọi thao tác này là “Đổi quà”/“Sửa” hoặc ngụ ý giữ chỗ quà cũ cho tới khi đổi thành công. Dòng nhiều chiếc phải phân biệt “Bỏ 1 chiếc để chọn lại” (giảm một) với “Bỏ toàn bộ {Q} chiếc”, không âm thầm xóa cả dòng khi khách chỉ muốn bỏ một.

**UX-03 — Xem trước khi bỏ.** Dù đã đủ suất, trong phần mở rộng khách vẫn mở thẻ, xem mẫu và phiên bản khác được; chỉ thao tác nhận thêm bị khóa với lý do đúng. Xem/chọn chip không mutation, không giữ chỗ, không nới entitlement/stock. Sau bỏ thành công, báo cụ thể món/số lượng đã bỏ, ví dụ “Đã bỏ quà cũ khỏi đơn.” Chỉ mời chọn lại nếu dữ liệu mới còn quyền/lựa chọn. Nếu nhận thay thế bị từ chối và đã xác định không ghi, nói rõ món mới chưa được thêm và số suất thực tế chưa chọn; không chỉ báo lỗi chung, không tự phục hồi quà cũ. Mất phản hồi phải đọc lại trước khi đưa kết luận này.

| Thao tác/kết quả | Lựa chọn được giữ |
|---|---|
| Chỉ mở/đóng phần xem, xem mẫu khác hoặc hủy trước khi bấm bỏ | Không gọi mutation; giữ toàn bộ lựa chọn đã lưu. |
| Đang đủ một suất size S, khách bấm bỏ | Gửi bỏ S; chỉ mở khả năng nhận thay thế sau khi server xác nhận trạng thái mới. Không gửi thêm M trước để vượt entitlement. |
| Bỏ bị từ chối và đã xác nhận không ghi | S vẫn là lựa chọn đã lưu; báo lỗi, chưa thêm M. Quà mất hiệu lực phải được đánh dấu lỗi, không hứa sẽ được giao. |
| Bỏ S thành công | S không còn được chọn. Khách chủ động nhận M hoặc mẫu khác theo trạng thái mới; các quà khác không bị đụng tới. |
| Sau khi bỏ thành công, khách hủy/đóng hoặc lần nhận mới bị từ chối vì hết hàng/không ghi | Suất đó chưa chọn; không tự khôi phục S và không tự thay quà. Hiện tổng kết thực tế, cho thử lựa chọn khác hoặc đặt hàng theo luồng nhắc một lần khi quote hợp lệ. |
| Mất phản hồi của thao tác bỏ/nhận, chưa rõ đã ghi hay chưa | Không đoán S/M còn hay mất; khóa mutation tiếp theo và đặt hàng, đọc lại trạng thái server tại chỗ rồi mới cho tiếp tục. Nếu đọc lại lỗi, giữ cảnh báo và nút thử tải lại, không tự gửi lại thao tác ghi. |

Không thêm transaction đổi nhiều dòng, API swap hoặc cơ chế rollback tự động trong phạm vi này. Hạn chế được chấp nhận: sau khi khách đã bỏ thành công, quà cũ không được bảo đảm còn để chọn lại.

### UI-05 — Hình thức và thông báo

Dùng nâu–kem hiện có, viền mảnh, bo nhẹ và ít bóng; tham khảo `purchase-panel.tsx` thay vì tạo design system mới. Bình thường chỉ hiện “Đã thêm X/Y quà” theo số đã lưu; điều kiện và mốc mua thêm ở mức phụ. Không trải số tồn kho cùng nút nhận cho mọi biến thể trên toàn trang.

Nút không khả dụng có lý do đúng: đã hết, đã chọn mẫu này, đã đủ quà hoặc đang lưu. Trạng thái chọn có dấu tích/nhãn, không chỉ màu. Không tự cuộn hoặc tự đóng ngay sau món cuối khiến khách mất vị trí.

Phản hồi lưu/bỏ thành công phải nhìn thấy và được công nghệ hỗ trợ nhận biết mà không chuyển focus khỏi thao tác. Có thể dùng vùng `role="status"` tồn tại trước cập nhật, với nội dung đủ món/số lượng và `aria-atomic="true"`; không đánh dấu cả picker làm live region hoặc đọc lại toàn bộ danh sách mỗi lần. Nếu control cũ bị gỡ, giữ focus ở điểm hợp lý trong cùng khu vực, không nhảy sang nút đặt hàng. [W3C ARIA22](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA22) là kỹ thuật tham khảo, không bắt buộc một cách viết markup duy nhất. Nghiệm thu có kiểm tra screen reader thủ công; axe/DOM assertions không chứng minh lời đọc thực tế.

### UI-06 — Lượng thông tin và bố cục đối chiếu

**UX-04 — Hai vai trò:** danh sách đơn cho khách kiểm tra những món sẽ nhận, bao gồm dòng quà; khu vực quà dùng chọn/quản lý. Khi khách chủ động thu gọn, hoặc vào checkout với quà đã đủ và hợp lệ, khối quà chỉ cần trạng thái số lượng ngắn và nút mở chi tiết, ví dụ “Đã thêm đủ 2 quà vào đơn — Xem lựa chọn quà”. Không render lại ảnh/tên/phiên bản/số lượng và nút bỏ của từng dòng trong khối thu gọn. Mở chi tiết mới hiện quản lý và duyệt lựa chọn khác theo UI-04; “Xem” không chỉ lặp nội dung đang hiện. Không xóa dòng quà khỏi danh sách đơn và không tự thu gọn ngay sau khi nhận món cuối. Trạng thái chưa thêm, chưa rõ kết quả hoặc cần sửa vẫn phải có thông báo ngắn khi thu gọn; không dùng nhãn “đủ” cho quà lỗi/thiếu lựa chọn.

| Trạng thái | Nội dung chính hiển thị | Hành động chính của khu vực quà |
|---|---|---|
| Chưa mở, còn lựa chọn hợp lệ | “Quà dành cho bạn”, một dòng số còn có thể chọn; không dàn điều kiện hoặc biến thể | “Chọn quà ngay” |
| Đang chọn | Một dòng tiến độ theo số đã lưu; tổng kết quà đã thêm nếu có; thẻ ảnh + tên. Chỉ mẫu đang mở có phiên bản và trạng thái chưa thêm/đang thêm/đã thêm | “Nhận quà này” ở mẫu đang mở khi hợp lệ; checkout có đường quay lại theo FLOW-02 |
| Đã chọn đủ, hợp lệ | Thu gọn: số quà đã thêm và nút mở, không lặp từng món. Đang mở: giữ phần quản lý, không tự đóng sau món cuối | “Xem quà đã chọn”/“Xem lựa chọn quà” mở quản lý, xem mẫu khác; bỏ/chọn lại chỉ trong phần mở rộng |
| Có phần không thể cấp | Tổng kết nếu có, số còn chọn được và thông báo trung tính cho phần không thể cấp | Chỉ “Chọn quà ngay” nếu còn lựa chọn; nếu không thì chỉ xem/bỏ quà đã chọn |
| Quà đã chọn mất hiệu lực | Chỉ rõ dòng cần bỏ/chọn lại; thông báo đặt hàng đang tạm khóa; form nhận hàng vẫn giữ | Bỏ dòng lỗi, sau đó chọn lại nếu còn quyền/lựa chọn |

Mẫu sắp xếp để duyệt trong spec (không phải ảnh giao diện đã chạy):

| Bề mặt | Thứ tự và cách bố trí |
|---|---|
| Mobile checkout, mẫu 390px | Vùng danh sách đơn có thể thu gọn → khối quà luôn thấy, bộ chọn mở ngay bên dưới → các phần checkout còn lại. Thẻ ảnh ngang một cột, phiên bản nằm dưới thẻ đang mở; không lặp lại hàng mua trong khối quà. |
| Desktop checkout, mẫu 1440px | Giữ form ở cột hiện có; trong cột danh sách đơn: hàng mua/quà trong đơn → khối quà → tổng kết tiền. Nếu cột hẹp, thẻ quà một cột; không ép hai cột hoặc thêm bản sao picker bên form. |
| Cart (cập nhật 2026-10-17) | Khối quà tương tác → thông báo ưu đãi khác nếu có → danh sách hàng mua trong cùng cột nội dung; aside chỉ giữ phần tổng kết. Không có thêm banner đạt quà với nút “Chọn quà” trùng lặp. |

Điều kiện chương trình nằm trong phần phụ có thể mở rộng; quy tắc đang trực tiếp giới hạn thao tác phải hiện cạnh lựa chọn liên quan. Gợi ý mua thêm nằm ở khu vực riêng, không chèn giữa các thẻ quà. Quà có nhãn “Quà tặng”, không dùng cách hiển thị giá khuyến mãi/nút mua làm khách tưởng phải trả thêm tiền. Mỗi vùng đang thao tác chỉ có một hành động nhận quà nổi bật. Khi implementation, đối chiếu ảnh chụp mobile/desktop với bảng này và AC-24/AC-28; không thêm yêu cầu một bộ thiết kế độ chi tiết cao hoặc duyệt từng pixel.

## 5. Popup nhắc một lần và lần đặt hàng tiếp theo

### FLOW-01 — Điều kiện mở

Sau khi kiểm tra khóa submit và các trường bắt buộc, nếu quote/lựa chọn hợp lệ nhưng còn `unclaimed > 0` và lượt này chưa được nhắc: chặn submit, mở popup, chưa tạo đơn.

Lần mở này không gọi luồng tạo snapshot đơn có thể submit, không giữ kho, không gửi POS, không xóa giỏ và không phát sự kiện purchase. Quà chưa chọn không phải một lỗi trường dữ liệu. Nếu địa chỉ/số điện thoại thiếu hoặc sai, hiện lỗi trường trước; chưa tính là đã nhắc quà.

Không popup khi đã chọn đủ, không có quyền nhận, hoặc quote chỉ có giảm giá theo số lượng. Lỗi quà đã chọn không hợp lệ phải được xử lý như lỗi nghiệp vụ, không bị chuyển thành nhắc tùy chọn.

### FLOW-02 — Nội dung và hành động

Tiêu đề: **Bạn còn quà chưa chọn**.

Nội dung bình thường: “Bạn còn {N} món quà chưa chọn. Bạn có thể chọn quà ngay hoặc tiếp tục đặt hàng mà không nhận phần quà còn lại.” Quà đã chọn trước đó vẫn được giữ.

- **Chọn quà ngay:** đóng popup, mở bộ chọn tại chỗ, đưa focus tới khu vực quà; không gửi đơn, không xóa dữ liệu form.
- **Vẫn đặt hàng:** là hành động đặt hàng thứ hai; tiếp tục bằng chính luồng submit của form với dữ liệu và quote đang hiển thị. Không hiện lại popup hoặc thêm checkbox/xác nhận thứ ba.
- **Đóng/X/Escape:** chỉ đóng, không gửi đơn và không xác nhận từ bỏ. Trả focus về nút đã mở popup. Lượt đã được nhắc; nếu khách sau đó chủ động bấm đặt hàng, tiếp tục không popup.

**UX-02 — Có đường quay lại thanh toán.** Khi bộ chọn mở tại checkout, kể cả mở từ popup, có thao tác phụ dễ thấy như “Quay lại thanh toán”. Đây là điều hướng trong trang tới vùng tổng kết thanh toán, không phải submit: không ghi/xóa lựa chọn, không cấp claim, không tạo đơn, không reset cờ đã nhắc và không tự thu gọn picker. Được quay lại khi đã nhận đủ, mới nhận một phần hoặc chưa nhận gì. Pending/refresh/kết quả ghi chưa rõ không khóa điều hướng này nhưng vẫn khóa mọi lối đặt hàng; kết quả trả về muộn không được lấy focus khỏi vị trí khách đã chuyển tới.

Thao tác quay lại chuyển cả focus và vị trí nhìn tới một điểm ổn định có tên trong vùng tổng kết, ưu tiên tiêu đề “Tổng kết thanh toán” hoặc tương đương, không chỉ scroll trong khi bàn phím còn ở picker và không focus thẳng vào nút submit. Có thể dùng tiêu đề với `tabIndex={-1}`; tên nút/markup cụ thể không phải điều kiện cứng. Thông báo phiên bản chưa thêm ở UI-04 vẫn nhìn thấy tại đây. Lần gửi đơn tiếp theo vẫn cần hành động chủ động và quote hợp lệ; không bắt nhận đủ quà. Đường này khác với X/Escape trả focus về nút mở popup. [WAI-ARIA dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) hỗ trợ lựa chọn focus theo bước hợp lý tiếp theo, không quy định phải có nút mang đúng tên ví dụ.

Nếu toàn bộ phần chưa nhận không thể cấp, dùng tiêu đề **“Một phần quà chưa thể nhận”** và nội dung mặc định “Hiện chưa có lựa chọn phù hợp cho {U} suất quà còn lại. Bạn vẫn có thể tiếp tục đặt hàng.” Không hiện CTA nhận thêm khi không còn lựa chọn. Chỉ thay bằng thông báo thiếu hàng cụ thể khi có dữ liệu chứng minh; không suy nguyên nhân từ tên trường đếm. Nếu vừa còn lựa chọn vừa có phần không thể cấp, nêu riêng “Bạn còn có thể chọn {A} món quà” và câu trung tính cho {U}; chỉ mời chọn phần có thể cấp. Cùng một popup, không mở thêm popup theo từng nguyên nhân/campaign. Việc tiếp tục vẫn đi qua luồng chuẩn; audit không ghi phần không thể cấp thành khách tự bỏ qua dù còn lựa chọn.

Popup là modal có tiêu đề và mô tả được liên kết đúng; giữ focus bên trong, nền không tương tác, có nút đóng. Focus ban đầu vào tiêu đề hoặc hành động chọn quà, không vào nút gửi đơn. Click/Enter lặp nhanh khi popup vừa mở không được vô tình thành lần xác nhận thứ hai. Đóng popup không bao giờ tự submit.

### FLOW-03 — Trạng thái và chuyển trạng thái

Tách trạng thái UI `unseen / open / seen` khỏi pending đơn và khỏi bằng chứng xác nhận quote.

| Trạng thái/sự kiện | Kết quả |
|---|---|
| Form thiếu/sai thông tin | Hiện lỗi; không mở popup, không đánh dấu đã nhắc. |
| `unseen`, submit hợp lệ, còn quà chưa nhận | Mở popup; chỉ ghi nhận đã nhắc khi popup thực sự được mở; không gửi đơn. |
| `open`, click lặp/Enter giữ phím/submit nền | Không tạo popup thứ hai, không gửi đơn. |
| `open`, chọn quà | Đóng → `seen`; mở picker; không gửi đơn. |
| `open`, đóng/X/Escape | Đóng → `seen`; không gửi đơn. |
| `open`, chủ động bấm “Vẫn đặt hàng” | Chuyển sang gửi đơn qua cùng cơ chế validation, proof và pending của form. |
| `seen`, bấm đặt hàng, vẫn còn quà chưa nhận | Không popup; tạo ý định xác nhận cho quote hiện tại và submit một lần. |
| `seen`, đã chọn đủ quà | Submit bình thường, không cần nonclaim acknowledgement. |
| Gửi lỗi có thể retry | Giữ đã nhắc trong cùng lượt; lần retry không nhắc quà lại. |
| Quote đổi/refresh | Giữ trạng thái đã nhắc, nhưng không tái sử dụng acknowledgement của quote cũ. |
| Quà đã chọn mất hiệu lực, quote không tạo được | Giữ form và trạng thái đã nhắc; đóng popup nếu đang mở, chặn gửi đơn, chuyển sang sửa quà tại chỗ theo DATA-03. Không tự gửi lại khi sửa xong. |
| Đơn được xác nhận/giỏ bị xóa/lượt kết thúc | Xóa trạng thái UI của lượt; không áp dụng cho đơn tiếp theo. |

State “đã nhắc” không gắn với `benefit.digest`: digest có thể đổi sau khi chọn quà hoặc refresh. Không dùng chung cờ dismiss với upsell; `paidCartKey` của upsell đổi khi mua thêm cũng không được vô tình làm popup nhắc lại trong cùng lượt. Có thể dùng khóa lượt/giỏ opaque riêng; không đưa bearer cookie hoặc cart secret vào client/storage.

Khôi phục theo tab chỉ lưu thông tin UI tối thiểu, có kiểm tra cấu trúc. Nếu storage bị chặn/hỏng, fallback bộ nhớ trong lượt đang mở; không làm checkout crash. Hạn chế được chấp nhận để review: reload khi storage không dùng được có thể nhắc lại một lần, nhưng không được nhắc lặp trên các lần submit trong cùng mount. Khôi phục cờ nhắc sau reload không có nghĩa là lưu tên, điện thoại, địa chỉ hoặc ghi chú vào storage.

## 6. Hợp đồng submit và các bất biến an toàn

### DATA-01 — Nguồn dữ liệu duy nhất

Server vẫn quyết định giá, campaign/revision, quyền nhận, giới hạn trùng theo sản phẩm gốc, READY stock và nhu cầu tồn kho cộng gộp hàng mua + quà. Không thay công thức `earned`/`entitled`, không dùng tổng stock client để thay validation engine.

Bộ chọn checkout phải lấy đầy đủ campaign/lựa chọn hiện hành độc lập với danh sách quà vừa mở khóa bởi upsell. Bổ sung dữ liệu vào route/model qua nguồn hiện có; không tạo một engine tính quyền nhận mới. `skippedWhileAvailable` và `shortForStock` phải được bảo toàn trong snapshot/audit.

`unfulfillableForStock`/`shortForStock` là số tổng hợp khả năng cấp, không phải mã nguyên nhân thuần tồn kho. Projection dùng kết quả validation hiện có để tách phần có thể chọn, phần chưa thể cấp và xử lý tồn dùng chung; không cộng stock hoặc số suất từng campaign một cách độc lập để hứa nhận được tất cả. Đổi nội dung hiển thị theo UI-02/FLOW-02, không rename schema/audit hoặc bổ sung engine phân loại chỉ để có thông báo cụ thể hơn. Fixture sẵn có: [cart-gift-model.test.ts](../../tests/domain/cart-gift-model.test.ts), test `GQ14-F2`.

### DATA-02 — Thay checkbox, không bỏ xác thực

Giữ tương thích transport `nonclaimAcknowledged=yes` nếu không có lý do thay API. Ý nghĩa UI mới: khách chủ động gửi đơn sau khi đã được nhắc, không còn là “đã tick checkbox”. Cập nhật tên mô tả/comment/test liên quan; không cần rename public field chỉ để đổi giao diện.

Chỉ tạo/gửi claim này trong hành động đặt hàng chủ động sau nhắc, cho quote hiện đang được trình bày. Không đặt hidden input luôn bằng `yes`; mở/đóng popup, xem ảnh, chọn chip, trạng thái storage hoặc số lần click không tự cấp claim. Không đổi strict parsing thành chấp nhận mọi giá trị truthy.

`reminderSeen` là trạng thái tiện ích UI, không phải bằng chứng bảo mật. Server không chứng minh được khách đã đọc popup bằng một boolean từ browser. Server vẫn dùng giỏ từ HttpOnly cookie, xác minh quote proof với quote vừa tính lại, rồi mới cấp/kiểm tra signed acknowledgement cho đúng quote và ghi nhận thời điểm theo cơ chế hiện có. Không nhận cart identity, giá, quyền nhận hoặc chữ ký tự tạo từ client.

### DATA-03 — Quote thay đổi và lỗi thực sự

Giữ `PRICE_CHANGED` và các kiểm tra stale/tampered/cross-cart proof. Khi quote đổi, không tự đặt lại đơn sau refresh và không mang chữ ký/acknowledgement cũ sang quote mới. Khách phải nhìn thấy thông báo và báo giá mới rồi chủ động gửi lại; không hiện thêm popup nhắc quà trong cùng lượt đã nhắc. Lần gửi mới là ý định mới với proof hiện tại, không phải replay đồng ý cũ.

**Quà đã chọn mất hiệu lực phải sửa được ngay tại checkout.** Với `GIFT_SELECTION_INVALID` do hết hàng, đổi/hết hạn campaign hoặc quyền nhận thay đổi, route/model phải cung cấp trạng thái sửa quà và dữ liệu tối thiểu để xem/bỏ lựa chọn, độc lập với việc có quote hợp lệ. Không dùng nhánh `unquotable` hiện tại để thay toàn bộ form bằng link về giỏ. Đây là mở rộng có giới hạn cho lỗi lựa chọn quà; không biến mọi lỗi giá/POS/lookup thành lỗi có thể bỏ qua.

Giữ một owner dữ liệu form tồn tại qua chuyển trạng thái **ready → sửa quà → ready**, trong cùng lượt tại checkout. Ưu tiên giữ component form ổn định hoặc nâng state lên phần cha checkout không bị tháo khi quote đổi; không key owner theo digest/trạng thái. Phải bảo toàn cả tên, điện thoại, tỉnh, xã, số nhà/đường và ghi chú, kể cả textarea hiện chưa controlled. Không bổ sung global store, dependency, database draft hoặc lưu PII vào local/sessionStorage. Bảo toàn ở đây là qua render/refresh quote và sửa quà tại chỗ, không hứa khôi phục dữ liệu form sau full browser reload hoặc rời checkout.

Trong trạng thái sửa quà:

- Hiện rõ những lựa chọn cần xử lý; giữ nhãn đã có hoặc fallback “Quà đã chọn không còn khả dụng” nếu catalog/campaign không còn trả nhãn. Route phải giữ định danh cần để bỏ đúng dòng đã lưu kể cả khi danh sách campaign hiện hành rỗng; không tạo quyền nhận từ dữ liệu cũ.
- Cho khách chủ động bỏ từng dòng lỗi bằng đường mutation hiện có, kể cả khi còn dòng lỗi khác hoặc quyền nhận hiện tại bằng 0. Không khóa thao tác bỏ chỉ vì thiếu quote proof hợp lệ; thao tác vẫn cần cart ownership, kiểm tra input và khóa server hiện có. Thêm/giảm khác 0 vẫn phải đạt validation toàn bộ tập lựa chọn; không nới engine để cứu giao diện.
- Khóa mọi lối đặt hàng khi lựa chọn/quote chưa hợp lệ, kể cả “Vẫn đặt hàng” và Enter. Không gửi proof cũ, không tạo đơn/giữ kho/gửi POS. Tổng tiền cũ nếu giữ để tham khảo phải ghi rõ đang chờ tính lại, không coi là báo giá có thể xác nhận.
- Sau mỗi lần bỏ thành công, tải lại trạng thái tại chỗ; khi tập lựa chọn hợp lệ, tính lại quote/proof hiện hành rồi mới mở các thao tác tương ứng. Khách có thể chọn quà khác **hoặc để trống**. `selected = 0` không tự là lỗi; không buộc nhận một quà mới để thoát trạng thái sửa.
- Không tự xóa/thay quà, không khôi phục món đã bỏ, không reset cờ đã nhắc. Sửa xong không tự submit. Nếu lượt chưa nhắc và vẫn còn suất chưa nhận, lần đặt hàng hợp lệ tiếp theo mới mở popup; nếu đã nhắc thì không nhắc lại.

Nếu không đọc được trạng thái từ server, giữ dữ liệu form trong bộ nhớ, báo chưa thể kiểm tra và cho thử tải lại tại chỗ; không đoán lựa chọn, quyền nhận hoặc kích hoạt đặt hàng. Giỏ hết hạn/đã xóa hoặc kết quả đơn chưa rõ vẫn giữ các chốt an toàn hiện có. Không bắt buộc xây cơ chế khôi phục mọi lỗi hệ thống trong feature này.

Một cơ chế pending/busy chung phải bảo vệ chọn quà, refresh quote, upsell và submit. Chặn double-click đồng bộ trước khi render pending; tất cả lối gửi (nút form, Enter hợp lệ, nút popup) đi qua cùng kiểm tra. Giữ idempotency, reconciliation và khóa retry khi kết quả gửi đơn chưa chắc chắn. Không tạo đường gửi riêng trong popup hoặc tự retry request có thể đã tạo đơn.

### DATA-04 — Ranh giới tin cậy

Browser/form/storage, tên sản phẩm và nguồn ảnh là dữ liệu cần kiểm tra; quote/order/inventory/POS ở phía server là ranh giới quyết định. Các tài sản phải bảo vệ: tiền đơn, quyền nhận, tồn kho, tính duy nhất đơn và thông tin người nhận.

Các abuse case bắt buộc: giả `nonclaimAcknowledged`, đổi giá/count/cart ID, proof cũ/giỏ khác, ảnh URL không được phép và submit đồng thời. Không nới rate limit/auth/CSRF vì popup. Không log form, PII, cookie, quote proof hoặc signed acknowledgement; dùng tín hiệu checkout/benefit hiện có để quan sát lỗi.

## 7. Tiêu chí nghiệm thu và kiểm thử implementation

| ID | Kịch bản và kết quả bắt buộc |
|---|---|
| AC-01 | Hàng đang mua không lặp trong picker; paid segments khác đơn giá vẫn nguyên vẹn; quà đã chọn vẫn kiểm tra được. |
| AC-02 | Lời nhắc nằm dưới vùng danh sách trên cart và checkout, nhìn thấy khi mobile summary thu gọn; không còn checkbox/khối từ bỏ sau ghi chú. |
| AC-03 | Tổng tiền, giảm giá, ship, tier notice cần thiết và nội dung form không bị mất/sửa ngoài phạm vi. |
| AC-04 | Thẻ ảnh/fallback, nhãn, lựa chọn phiên bản và nhận/bỏ/giảm số quà đúng theo UI-04; không đoán thuộc tính từ chuỗi hoặc ngụ ý đổi nguyên tử. |
| AC-05 | Không mua thêm hoặc đã dismiss upsell vẫn chọn được mọi quyền nhận hợp lệ, kể cả nhiều campaign. |
| AC-06 | Chưa chọn hoặc chọn một phần: submit hợp lệ lần đầu chỉ mở đúng một popup, không tạo đơn/giữ kho/gửi POS/purchase event. |
| AC-07 | “Vẫn đặt hàng” trong popup gửi đúng một đơn qua luồng chuẩn; không có popup/checkbox xác nhận thứ ba. |
| AC-08 | Đóng/X/Escape không gửi đơn; bấm đặt hàng tiếp theo không nhắc lại và được đi tiếp nếu các kiểm tra khác đạt. |
| AC-09 | Chọn hoặc bỏ/chọn lại quà từ popup không mất tên, điện thoại, tỉnh/xã, địa chỉ, ghi chú; sau quote refresh còn nguyên dữ liệu, chọn đủ hoặc còn thiếu rồi đặt hàng không bị nhắc lại trong lượt. |
| AC-10 | Không có quyền nhận/đã chọn đủ/tier-only không popup; thông tin nhận hàng thiếu hoặc sai hiện lỗi trước, chưa đánh dấu đã nhắc. |
| AC-11 | Lưu quà lỗi, refresh đang chạy, upsell pending hoặc submit pending không cho gửi dữ liệu cũ; phục hồi xong không nhắc lặp. |
| AC-12 | Đổi lựa chọn, mua thêm, render lại hoặc retry lỗi có thể phục hồi giữ cờ đã nhắc trong lượt; thành công/giỏ khác/lượt mới không kế thừa cờ. |
| AC-13 | Reload cùng lượt khôi phục theo R-01; storage thiếu/hỏng theo fallback, không crash hoặc tạo xác nhận tự động. |
| AC-14 | Proof cũ/tampered/cross-cart vẫn bị từ chối; `PRICE_CHANGED` hiển thị quote mới, không tự resubmit, không replay ack cũ. |
| AC-15 | Thứ tự first reminder → second submit → server proof verification → acknowledgement → snapshot/order được chứng minh; không chỉ test biến boolean. |
| AC-16 | Quà đã chọn không hợp lệ chặn đặt hàng và có lối sửa tại checkout theo DATA-03, không ép về cart. Phần chưa chọn do thiếu hàng/thiếu mẫu hợp lệ khác với chủ động không chọn; copy đúng dữ liệu, snapshot/audit giữ ngữ nghĩa engine. |
| AC-17 | Giới hạn entitlement, không trùng sản phẩm gốc, stock chung giữa campaign và paid/gift không bị yếu đi. |
| AC-18 | Double-click, Enter lặp, popup vừa mở và hai lối submit không tạo đơn trùng; kết quả POS chưa rõ không bị retry mù. |
| AC-19 | Modal dùng bàn phím được, focus vào/ra đúng, nền inert, nút có tên; không gửi đơn khi chỉ đóng hoặc chọn quà. |
| AC-20 | Kiểm tra 320/375/390/768/1024/1440px và zoom chữ 200%: không tràn ngang, không bị bàn phím/mobile viewport che CTA; vùng bấm khoảng 44px khi khả thi. |
| AC-21 | Điền đầy đủ cả ghi chú → fixture làm quà đã chọn hết hàng/hết hạn campaign → refresh route thành không tạo được quote → form/dữ liệu vẫn còn và đặt hàng bị khóa → bỏ dòng lỗi tại chỗ → có quote/proof mới → chọn lại hoặc để trống, dữ liệu form vẫn nguyên. Chạy cả khi có nhiều dòng lỗi và campaign cuối cùng biến mất; không tự submit hoặc nhắc lại nếu đã nhắc. Vào checkout lần đầu với quà lỗi cũng phải có lối bỏ tại chỗ. |
| AC-22 | Đã đủ 1 suất S: chỉ xem/hủy giữ S, không mutation; bỏ thất bại có xác nhận không ghi giữ S; bỏ thành công rồi nhận M hoặc mẫu khác thành công chỉ giữ lựa chọn mới. Bỏ thành công rồi hủy/nhận mới bị từ chối để suất trống, không tự phục hồi S; quà khác không mất. Mất phản hồi phải đọc lại server trước khi cho thao tác tiếp. Dòng nhiều chiếc dùng đúng giảm một hoặc bỏ toàn bộ theo nhãn. |
| AC-23 | Entitled 2, chỉ 1 mẫu còn 10 chiếc, cấm trùng: trước chọn chỉ có thể chọn 1, suất còn lại có copy trung tính; sau chọn 1 thì số còn có thể chọn là 0, giữ tiến độ 1/2 và không hiện CTA nhận thêm/“hết hàng”/“đã chọn đủ”. Popup một lần dùng copy phần chưa thể nhận; không ghi suất không thể cấp thành tự bỏ dù còn lựa chọn. Kiểm tra thêm thiếu stock thật và nhiều campaign dùng chung stock. |
| AC-24 | Ảnh chụp implementation mobile 390px và desktop 1440px đối chiếu UI-06 ở các trạng thái chưa mở, đang chọn, đủ, thiếu lựa chọn và cần sửa. Thứ tự thông tin/CTA đúng, phần phụ không lấn nội dung chính; chỉ một picker hoạt động, không trùng ID hoặc render lại danh sách hàng mua trong picker. Không coi ảnh mẫu trong spec là bằng chứng runtime. |
| AC-25 | UX-01: form hợp lệ → popup → chọn quà ngay → chỉ bấm size M → quay lại thanh toán: không mutation, số quà đã lưu không tăng, không nhãn thành công; “chưa thêm” nhìn thấy cả ở thẻ và vùng thanh toán. Lần submit chủ động tiếp theo không nhắc lại và chỉ dùng quà đã lưu, không tự thêm M. Nhánh bấm nhận: thấy pending, count chưa tăng; xác nhận lưu/readback mới cập nhật count/tổng kết và thông báo thành công, focus không bị cướp. Kiểm tra mất phản hồi không báo thành công sớm và quote refresh vẫn khóa submit. |
| AC-26 | UX-02: điền đầy đủ cả note → đặt hàng → popup → mở picker → nhận quà và chờ quote mới → quay lại thanh toán: dữ liệu nguyên, focus ở điểm có tên trong vùng thanh toán, chưa tạo order/reservation/POS/purchase; lần đặt hàng chủ động tiếp theo đi qua pipeline chuẩn một lần, không nhắc lại. Chạy cả nhận đủ và nhận một phần, mobile/desktop và bàn phím. Khi quay lại lúc pending/uncertain, vẫn khóa submit tới khi readback/quote hợp lệ; không tự submit hay lấy lại focus khi response tới. |
| AC-27 | UX-03: đã đủ suất vẫn xem được mẫu/size khác, nhưng không nhận thêm và không mutation khi xem/hủy. Cảnh báo bỏ trước nhìn thấy cạnh hành động trong phần mở rộng trước khi bấm; sau bỏ thành công có thông báo món/số lượng đã bỏ. Nhận mới bị từ chối đã xác định không ghi: thông báo món mới chưa thêm, count và suất trống đúng server, không tự khôi phục cũ; các quà khác nguyên vẹn. Bao phủ giảm một/bỏ toàn bộ và mất phản hồi bằng readback. |
| AC-28 | UX-04: vào checkout với quà đủ hợp lệ hoặc chủ động thu gọn thấy count ngắn + nút mở, không danh sách ảnh/tên/phiên bản và nút bỏ lặp trong khối thu gọn; dòng quà trong danh sách đơn vẫn còn. Mở chi tiết có quản lý/bỏ/chọn lại và duyệt mẫu khác thực sự hữu ích. Nhận món cuối không tự thu gọn/cuộn; pending/chưa thêm/quà lỗi không bị nhãn đủ che đi. Chụp cả mở/thu gọn ở 390/1440px, đối chiếu cùng AC-24. |

AC-25..AC-28 là phần nghiệm thu mới sau review `87b7cd5`, không được suy là đã có chỉ vì ma trận AC-01..AC-24 đầy đủ. Cần duyệt phần spec bổ sung này cùng plan trước task triển khai liên quan.

Unit/domain: kiểm tra state machine, projection quyền nhận, parsing/claim, proof và các chuyển trạng thái. Tách logic điều phối đủ nhỏ để test bằng `node:test`, không mock thay engine quyền nhận. Tái dùng fixture thiếu mẫu hợp lệ trong `tests/domain/cart-gift-model.test.ts`; cập nhật test `GIFT_SELECTION_INVALID` ở `tests/domain/checkout-benefit-ui.test.ts` cho lối sửa tại chỗ nhưng vẫn giữ coverage chặn submit và các lỗi không liên quan.

Integration/database: kiểm tra snapshot/audit, reservation, lỗi quote và chống đơn trùng bằng môi trường test riêng. Update bài test mô tả checkbox sang hành động sau nhắc, nhưng giữ coverage bảo mật của strict parsing/proof. Tham khảo `tests/domain/guest-checkout-public-actions.test.ts`.

Browser: kiểm tra DOM thực, trạng thái modal, bàn phím/focus, responsive, nội dung form và network của hai lần bấm. AC-21 phải đi qua nhánh route/page sau refresh, không chỉ mock boolean lỗi trong picker; AC-22 phải kiểm tra lựa chọn đã lưu sau từng kết quả. Mã nguồn có chuỗi “popup” hay test snapshot HTML không thay thế được kiểm tra first-click không gửi request tạo đơn và second-click đi hết luồng. Chỉ chạy tạo đơn/POS với test fixture hoặc sandbox được cho phép, không dùng checkout production để thử.

C2 kiểm tra sớm trạng thái thẻ/thông báo của AC-25, xem trước và phản hồi AC-27, quản lý mở/thu gọn AC-28. Hành trình trọn vẹn popup → picker → thanh toán ở AC-25/AC-26 được nối tại T08/T10 và nghiệm thu lại T12; không coi các bài test modal/picker riêng lẻ là thay thế. Ghi kết quả screen reader/browser thực tế cho status và focus; phần chưa có công cụ/người kiểm tra phải ghi pending, không suy pass từ axe.

## 8. Stack, lệnh, cấu trúc và quy ước code

Theo `package.json` tại baseline: Node `>=22.14.0`, `pnpm@11.4.0`, Next `16.3.3`, React/React DOM `19.2.0`, Prisma `7.9.1`; TypeScript `^5.9.0`, Tailwind `^4.0.0`. Không nâng phiên bản trong feature này.

Lệnh có thật trong repository, dành cho implementation sau khi cài đúng môi trường/dependency:

```sh
pnpm dev
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/guest-checkout-public-actions.test.ts
```

`pnpm test:db` cần database test riêng và cấu hình thích hợp. Không suy rằng repo có `pnpm test:e2e`; package hiện chưa khai báo lệnh đó. Browser verification phải ghi công cụ và fixture thực tế sử dụng. Các lệnh trên là kế hoạch kiểm chứng, không phải bằng chứng đã chạy trong PR tài liệu.

Những vùng dự kiến cần sửa trong implementation, không phải danh sách file đã sửa:

| Vùng | Trách nhiệm |
|---|---|
| `src/components/brand/cart-gift-picker.tsx`, `purchase-panel.tsx` | Làm lại presentation quà; tham khảo style/chip hiện có, không refactor purchase panel ngoài phạm vi. |
| `src/components/headless/use-cart-gifts.ts` | Tái sử dụng mutation/pending; phối hợp bỏ/chọn lại và đọc lại khi mất phản hồi, không tạo đường lưu song song. |
| `src/commerce/cart-gift-selection.ts`, `src/commerce/product-media.ts`, `src/routes/cart-gift-model.ts` | Bổ sung ảnh an toàn và dữ liệu hiển thị, giữ định danh dòng lỗi để bỏ; dùng đúng số khả năng cấp và copy trung tính. Không thêm API swap. |
| `src/app/cart/page.tsx`, `src/app/checkout/page.tsx` | Đặt khu vực quà dưới danh sách; giữ paid segments, totals và bố cục theo breakpoint; không tháo owner dữ liệu form khi chuyển sang sửa quà. |
| `src/routes/checkout.ts`, `src/routes/checkout-model.ts` | Đưa toàn bộ dữ liệu picker/count vào checkout độc lập upsell; tách lỗi quà có thể sửa khỏi nhánh unquotable chung, giữ submit khóa nếu chưa có proof hiện hành. |
| `src/components/commerce/guest-checkout-form.tsx`, `src/components/brand/guest-checkout-form.tsx` | Owner luồng submit/modal và dữ liệu nhận hàng kể cả ghi chú qua ready → sửa quà → ready; không lưu PII vào storage. |
| `src/components/commerce/checkout-upsell.tsx` | Gỡ coupling/filter picker theo quà mới mở khóa; giữ chức năng mua thêm và busy coordination. |
| `src/commerce/guest-checkout-public-actions.ts`, `guest-checkout-submit-runtime.ts` | Rà soát claim từ lần gửi chủ động và tương thích; giữ server verification và giới hạn hiện có. |
| `tests/domain/`, `tests/integrations/`, `tests/database/` | Regression, proof, snapshot và concurrency theo phạm vi tương ứng. |
| `docs/specs/`, tài liệu/checklist đang nhắc FR-06/GQ19 | Ghi hành vi mới và liên kết bản bổ sung sau khi được duyệt. |

Theo cấu trúc hiện có: route/model quyết định dữ liệu, headless/controller điều phối state/mutation, brand component trình bày. Không đưa tính toán quyền nhận vào JSX. Tên thể hiện nghĩa `reminderSeen` khác `nonclaimAcknowledged`; tránh một boolean vừa mở modal vừa cho phép gửi đơn.

Ví dụ style type thực tế từ `src/routes/checkout-model.ts` (minh họa quy ước, không phải contract mới):

```ts
export type CheckoutGiftLineView = Readonly<{
  lineKey: string;
  label: string;
  quantity: number;
  priceText: string;
}>;
```

Giữ TypeScript readonly/discriminated states khi hữu ích, naming đang có, semantic button/form và framework escaping. Không thêm thư viện modal/state management chỉ cho thay đổi này. API framework khi build phải kiểm tra theo đúng phiên bản và tài liệu bundled/official, không sao chép ví dụ phiên bản khác.

Tham khảo chính thức đã tra khi soạn spec: [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) cho focus/keyboard/nền inert; [Next.js Forms](https://nextjs.org/docs/app/guides/forms) cho form, validation và pending. Bản sửa đã đối chiếu thêm [React: Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state): tháo component khỏi cây render làm mất state, là lý do DATA-03 phải giữ owner dữ liệu ổn định. Đây không phải bằng chứng đã chạy component trên Next `16.3.3`. Bổ sung UX tại PR #174 đã đọc lại WAI-ARIA dialog và [W3C ARIA22 — status messages](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA22); không coi hướng dẫn này là bắt buộc tên nút hoặc bố cục cụ thể.

## 9. Ranh giới, rủi ro và quality gate

**Luôn làm:** giữ server authority; xác thực input/proof; bảo toàn dữ liệu form; test hành vi trước khi sửa logic; review diff đúng phạm vi; kiểm tra browser cho thay đổi giao diện; ghi rõ bằng chứng đã chạy/chưa chạy.

**Hỏi trước:** thay schema/snapshot/public API không tương thích, thêm dependency, đổi auth/storage nhạy cảm, CI, cơ chế retry hoặc tích hợp POS; thay các mặc định R-01..R-04 sau khi spec đã được duyệt.

**Không làm:** tự chọn/thay/xóa quà, default acknowledgement thành true, bỏ test bảo mật để pass, force-push main, commit secret/PII, tạo đơn thử production, hoặc gọi bản đặc tả là tính năng đã hoàn thành.

Rủi ro chính là trộn “đã nhắc” với “đã đồng ý quote”, mất form khi quà lỗi, kỳ vọng sai khi bỏ/chọn lại, gọi thiếu mẫu là hết hàng, bộ chọn bị khóa theo upsell, mount trùng ở hai breakpoint và hai đường submit tạo đơn trùng. Các hợp đồng UI-02/UI-04/DATA-03 và AC-05..AC-24 là chốt kiểm soát. AC-25..AC-28 bổ sung rủi ro nhầm chip là đã lưu, thiếu đường quay lại/focus và lặp thông tin khi quản lý quà. Không yêu cầu migration để ghi nhớ popup hoặc sửa các khoảng trống này; mọi nhu cầu migration phát hiện khi build phải quay lại review.

Definition of Done cho implementation: AC-01..AC-28 đạt; unit/integration phù hợp, lint/typecheck/build đạt; kiểm tra browser và đường lỗi có bằng chứng; không hồi quy quote/stock/snapshot; cập nhật tài liệu cũ liên quan; review security và rollout/rollback của thay đổi checkout trước release. Không coi một bộ test xanh là đủ khi chưa xác minh runtime.

Gate của PR #174: spec bổ sung UX và plan/checklist thống nhất, có task/kiểm chứng cho AC-25..AC-28, giữ đủ AC-01..AC-24; diff chỉ có tài liệu. Người phụ trách duyệt phần spec bổ sung và plan trước `/build`; T13 chỉ ghi kết quả thực hiện, không phải thời điểm mới quyết định UX. Không tự chuyển sang implementation, merge hoặc deploy trong PR này.


## Theo dõi implementation PR #175

Owner yêu cầu triển khai end to end và mở PR mới ngày 16/10/2026. [Evidence hiện hành](../verification/storefront-gift-picker-checkout-reminder.md) ghi lệnh, CI, AC và giới hạn kiểm tra. Các ghi chú chờ duyệt và CI lỗi ở phần lịch sử không thay thế trạng thái hiện hành này. Không coi merge plan là release chức năng.
