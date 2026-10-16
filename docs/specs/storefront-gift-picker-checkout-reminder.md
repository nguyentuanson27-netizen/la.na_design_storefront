# Spec — Chọn quà gọn hơn và nhắc một lần khi đặt hàng

**Project:** La.na Design Storefront
**Ngày:** 16/10/2026
**Trạng thái:** Đề xuất để review; yêu cầu chính đã được chủ cửa hàng xác nhận trong trao đổi, các mặc định chi tiết ở mục 2 cần được duyệt cùng spec.
**Baseline đã đối chiếu:** `main@e08715493c224a76e078d4c42b2565294e493d0d`.
**Phạm vi PR này:** Chỉ bổ sung tài liệu đặc tả. Không sửa giao diện, logic đặt hàng, database, cấu hình hoặc dependency; không triển khai tính năng.

## 1. Mục tiêu và phạm vi

Khách thấy quà được nhận ngay dưới danh sách sản phẩm, chọn quà bằng ảnh và thao tác ngắn, không phải đọc biểu mẫu dài hoặc xem lại hàng đang mua. Khách được quyền đặt đơn khi chưa chọn đủ quà, nhưng được nhắc một lần trước khi tiếp tục.

Yêu cầu đã chốt:

1. Không list lại sản phẩm đang mua bên trong khu vực chọn quà. Danh sách quà có thể chọn và quà đã chọn vẫn cần hiển thị.
2. Bỏ khối diễn giải không nhận quà và checkbox xác nhận đang nằm sau phần ghi chú, gần tổng tiền trong ảnh phản hồi. Không xóa các dòng tổng giá trị, giảm giá, vận chuyển hoặc tổng thanh toán.
3. Đặt lời nhắc chọn quà ngay dưới danh sách sản phẩm trong giỏ/checkout.
4. Nếu khách còn quà chưa chọn và bấm đặt hàng: lần đầu hiện popup nhắc; nếu khách vẫn bấm đặt hàng lần hai thì không nhắc lại, tiếp tục luồng đặt hàng bình thường.
5. Tổng hợp thiết kế đã trao đổi: thẻ ảnh thay dropdown sản phẩm, tiến độ ngắn, mở tùy chọn khi cần, tổng kết quà rõ ràng, phong cách nâu–kem hiện có.

“Đặt hàng bình thường” không có nghĩa là bỏ qua xác thực địa chỉ, giá, tồn kho, quyền nhận quà, quote proof, chống đặt trùng hoặc kết quả POS chưa rõ. Chỉ bỏ lần nhắc quà lặp lại; chỉ báo thành công sau khi hệ thống xác nhận đơn.

Không thuộc phạm vi: thiết kế lại toàn bộ checkout, thay luật tính khuyến mại/ship/giá, tự chọn hoặc tự thay quà, thay hợp đồng Pancake, carousel, hiệu ứng ăn mừng, bộ chọn nhiều popup, hoặc xóa chức năng gợi ý mua thêm độc lập.

## 2. Quan hệ với spec cũ và mặc định cần review

Đây là bản bổ sung cho [gift-quantity-promotions-v1.md](gift-quantity-promotions-v1.md), đặc biệt FR-06 và phần trình bày cart/checkout của FR-11. Sau khi spec này được duyệt, thao tác đặt hàng chủ động lần hai sau lời nhắc thay thế checkbox xác nhận. Không sửa ý nghĩa chọn từ 0 đến `entitled`, không tự thay quà và không chuyển quyền chưa nhận thành nợ quà. Giữ tài liệu cũ làm lịch sử; khi triển khai phải cập nhật các tham chiếu/checklist còn mô tả checkbox bắt buộc.

Các mặc định dưới đây là đề xuất cụ thể cho review, không phải các quyết định bổ sung đã được chủ cửa hàng xác nhận riêng:

- **R-01 — Phạm vi một lần:** một lượt checkout của cùng giỏ trong cùng tab; không reset vì render lại, refresh quote, đổi lựa chọn quà, mua thêm trong cùng lượt hoặc lỗi gửi đơn. Tải lại cùng lượt được khôi phục bằng trạng thái UI theo tab khi storage khả dụng. Rời checkout kết thúc lượt, đơn thành công/giỏ được xóa hoặc đổi sang giỏ khác bắt đầu lượt mới. Không lưu “đã nhắc” vĩnh viễn theo khách.
- **R-02 — Đếm lần bấm:** xét lần submit hợp lệ về các trường bắt buộc, không phải bộ đếm mọi click. Popup có nút “Chọn quà ngay” và “Vẫn đặt hàng”; nút thứ hai chính là lần đặt hàng thứ hai, không thêm bước xác nhận thứ ba. Đóng popup rồi bấm nút đặt hàng của form cũng là lần tiếp tục hợp lệ.
- **R-03 — Chọn thiếu và thiếu hàng:** áp dụng cả chưa chọn món nào và chọn một phần. Nếu phần chưa nhận chỉ do thiếu hàng, popup đổi nội dung đúng tình trạng và không mời chọn quà không khả dụng.
- **R-04 — Bộ chọn tại chỗ:** dùng cùng bộ chọn cho cart và checkout. Tại checkout phải mở được mà không điều hướng về `/cart`, để giữ thông tin nhận hàng và ghi chú.

Phê duyệt PR spec là checkpoint để chốt các mặc định này trước implementation. Không tự diễn giải “đã mở popup” thành xác nhận đặt đơn.

## 3. Hiện trạng đã đối chiếu trong repository

| Nguồn | Hiện trạng liên quan |
|---|---|
| `src/components/brand/cart-gift-picker.tsx` | Dropdown sản phẩm, danh sách biến thể dạng dòng, nhiều chỉ số và chưa có ảnh; có `#cart-gifts`. |
| `src/routes/cart-gift-model.ts` | Có campaign, quyền nhận, lựa chọn, nhãn biến thể và tồn kho; chưa có ảnh. Có phân biệt `earned`, `entitled`, phần chưa chọn và thiếu lựa chọn hợp lệ. |
| `src/components/headless/use-cart-gifts.ts` | Lưu theo từng thao tác nhận/bỏ quà; có pending và thông báo kết quả. |
| `src/app/cart/page.tsx` | Bộ chọn nằm trong aside tổng kết, không ngay sau danh sách hàng mua. |
| `src/app/checkout/page.tsx` | Danh sách đơn có bố cục mobile/desktop; dòng mua có thể tách theo đơn giá, dòng quà được phân biệt. |
| `src/components/commerce/guest-checkout-form.tsx` | `ackMissing` chặn submit; checkbox `nonclaimAcknowledged` được gắn với `benefit.digest`; khối quyền lợi nằm sau ghi chú. |
| `src/components/commerce/checkout-upsell.tsx` | Bộ chọn bị lọc theo `attempt.giftIds` sau mua thêm; không phải lối chọn tất cả quyền nhận sẵn có. |
| `src/routes/checkout-model.ts` | `CheckoutBenefitView.slots` có `entitled`, `selected`, `unclaimed`, `skippedWhileAvailable`, `shortForStock`. |
| `src/commerce/guest-checkout-public-actions.ts` và `guest-checkout-submit-runtime.ts` | Nhận literal `nonclaimAcknowledged=yes`; server chỉ cấp acknowledgement sau khi quote proof khớp với quote tính lại. |

Đây là nhận xét từ mã nguồn và ảnh người dùng, không phải kết quả chạy browser. Không kết luận mọi danh sách sản phẩm trong checkout là bản sao: các paid price segment khác đơn giá vẫn phải giữ nguyên.

## 4. Giao diện và chọn quà

### UI-01 — Một khu vực quà ngay dưới danh sách sản phẩm

Cart: chuyển khu vực quà khỏi aside xuống ngay sau danh sách hàng mua. Checkout: lời nhắc nằm ngay sau vùng danh sách đơn; không để sau địa chỉ/ghi chú hoặc chen giữa các dòng tổng tiền.

Lời nhắc và bộ chọn mở rộng là cùng một khu vực. Khi danh sách đơn trên mobile thu gọn, lời nhắc vẫn nhìn thấy ngay sau vùng thu gọn đó; không bắt khách mở danh sách mới biết có quà. Trên desktop giữ cấu trúc checkout hiện có, chỉ điều chỉnh vị trí/điểm gắn của khu vực quà.

Chỉ có một bộ chọn tương tác hoạt động và một owner cho trạng thái nhắc/submit. Không mount hai controller độc lập cho hai breakpoint, không trùng ID `cart-gifts`, không lồng form. Lời nhắc không phụ thuộc khách đã mua thêm, `attempt.giftIds`, hoặc bật/tắt gợi ý upsell. Không làm mất quyền chọn khi khách bỏ qua đề xuất mua thêm.

### UI-02 — Nội dung ngắn và đúng trạng thái

Trường hợp bình thường:

> **Quà dành cho bạn**
> Bạn còn **{N} món quà chưa chọn**.
> Chọn quà để nhận đủ ưu đãi của đơn hàng.
> **Chọn quà ngay**

`N` lấy từ quyền nhận đã xác thực, không hard-code và không suy từ số sản phẩm đang mua. Khi có thiếu hàng, tách số còn có thể chọn và số không thể cấp; không gán toàn bộ phần thiếu cho khách “từ bỏ”. Giữ chi tiết theo campaign khi nhiều chương trình có quy tắc khác nhau.

Khi chọn đủ và lựa chọn hợp lệ: ẩn lời nhắc, giữ tổng kết ngắn và “Chỉnh sửa quà”. Không có quyền nhận và không có lựa chọn cũ cần xử lý: ẩn toàn bộ khối. Lựa chọn cũ không hợp lệ vẫn phải hiện hướng xử lý dù quyền hiện tại bằng 0.

Bỏ khối checkbox trong ảnh, `ACK_MISSING_MESSAGE` và lỗi yêu cầu tích checkbox khi thay luồng. Không xóa `tierNotice` về thay đổi ưu đãi chỉ vì nó đang chung container; đưa thông báo còn cần thiết tới vùng tổng kết/phản hồi phù hợp.

### UI-03 — Thẻ quà bằng ảnh

Thay dropdown sản phẩm bằng thẻ có ảnh thật, tên và trạng thái. Mobile ưu tiên thẻ ngang; màn hình rộng có thể hai cột khi đủ chỗ. Không list lại hàng mua, không copy cả order summary vào bộ chọn. Gợi ý mua thêm phải tách rõ khỏi quà miễn phí.

Bổ sung ảnh ở nguồn dữ liệu và model quà, dùng cơ chế media tin cậy sẵn có, có fallback khi thiếu ảnh. Không đoán URL ảnh, không đưa URL tùy ý từ client vào fetch phía server. Dùng cùng tỷ lệ ảnh, có kích thước để tránh nhảy bố cục.

### UI-04 — Chọn mẫu, chọn phiên bản, nhận quà

Luồng: chọn mẫu quà → mở tùy chọn của mẫu đó → chọn phiên bản hợp lệ → “Nhận quà này”. Chỉ mở chi tiết một mẫu tại một thời điểm. Món chỉ có một lựa chọn hợp lệ không cần thêm một bước chọn lựa chọn duy nhất, nhưng vẫn phải có hành động nhận quà chủ động.

Hiện tại có thể dùng `option.label` làm chip. Chỉ tách màu/size khi dữ liệu thuộc tính rõ ràng; không cắt chuỗi để đoán. Thao tác chọn chip chưa ghi nhận quà; nút nhận mới gọi cơ chế lưu hiện có. Giữ lưu theo từng thao tác, không thêm “Lưu tất cả”.

Chỉ báo đã thêm sau kết quả lưu thành công. Pending khóa thao tác xung đột và nút đặt hàng; lỗi giữ ngữ cảnh để thử lại. Quà đã chọn có ảnh nhỏ, tên, phiên bản, số lượng khi cần và thao tác sửa/bỏ. Giảm số lượng vẫn khả dụng khi chương trình cho nhận nhiều chiếc cùng mẫu.

### UI-05 — Hình thức và thông báo

Dùng nâu–kem hiện có, viền mảnh, bo nhẹ và ít bóng; tham khảo `purchase-panel.tsx` thay vì tạo design system mới. Bình thường chỉ hiện “Đã chọn X/Y quà”; điều kiện và mốc mua thêm ở mức phụ. Không trải số tồn kho cùng nút nhận cho mọi biến thể trên toàn trang.

Nút không khả dụng có lý do đúng: đã hết, đã chọn mẫu này, đã đủ quà hoặc đang lưu. Trạng thái chọn có dấu tích/nhãn, không chỉ màu. Không tự cuộn hoặc tự đóng ngay sau món cuối khiến khách mất vị trí.

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

Nếu toàn bộ phần chưa nhận do thiếu hàng, dùng tiêu đề/nội dung “Quà tặng hiện chưa đủ hàng”, nêu rõ số chưa thể cấp và cho tiếp tục đặt hàng; không có CTA chọn một quà không khả dụng. Nếu vừa còn lựa chọn vừa thiếu hàng, nêu hai phần riêng và chỉ dẫn chọn phần có thể cấp.

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
| Đơn được xác nhận/giỏ bị xóa/lượt kết thúc | Xóa trạng thái UI của lượt; không áp dụng cho đơn tiếp theo. |

State “đã nhắc” không gắn với `benefit.digest`: digest có thể đổi sau khi chọn quà hoặc refresh. Không dùng chung cờ dismiss với upsell; `paidCartKey` của upsell đổi khi mua thêm cũng không được vô tình làm popup nhắc lại trong cùng lượt. Có thể dùng khóa lượt/giỏ opaque riêng; không đưa bearer cookie hoặc cart secret vào client/storage.

Khôi phục theo tab chỉ lưu thông tin UI tối thiểu, có kiểm tra cấu trúc. Nếu storage bị chặn/hỏng, fallback bộ nhớ trong lượt đang mở; không làm checkout crash. Hạn chế được chấp nhận để review: reload khi storage không dùng được có thể nhắc lại một lần, nhưng không được nhắc lặp trên các lần submit trong cùng mount.

## 6. Hợp đồng submit và các bất biến an toàn

### DATA-01 — Nguồn dữ liệu duy nhất

Server vẫn quyết định giá, campaign/revision, quyền nhận, giới hạn trùng theo sản phẩm gốc, READY stock và nhu cầu tồn kho cộng gộp hàng mua + quà. Không thay công thức `earned`/`entitled`, không dùng tổng stock client để thay validation engine.

Bộ chọn checkout phải lấy đầy đủ campaign/lựa chọn hiện hành độc lập với danh sách quà vừa mở khóa bởi upsell. Bổ sung dữ liệu vào route/model qua nguồn hiện có; không tạo một engine tính quyền nhận mới. `skippedWhileAvailable` và `shortForStock` phải được bảo toàn trong snapshot/audit.

### DATA-02 — Thay checkbox, không bỏ xác thực

Giữ tương thích transport `nonclaimAcknowledged=yes` nếu không có lý do thay API. Ý nghĩa UI mới: khách chủ động gửi đơn sau khi đã được nhắc, không còn là “đã tick checkbox”. Cập nhật tên mô tả/comment/test liên quan; không cần rename public field chỉ để đổi giao diện.

Chỉ tạo/gửi claim này trong hành động đặt hàng chủ động sau nhắc, cho quote hiện đang được trình bày. Không đặt hidden input luôn bằng `yes`; mở/đóng popup, xem ảnh, chọn chip, trạng thái storage hoặc số lần click không tự cấp claim. Không đổi strict parsing thành chấp nhận mọi giá trị truthy.

`reminderSeen` là trạng thái tiện ích UI, không phải bằng chứng bảo mật. Server không chứng minh được khách đã đọc popup bằng một boolean từ browser. Server vẫn dùng giỏ từ HttpOnly cookie, xác minh quote proof với quote vừa tính lại, rồi mới cấp/kiểm tra signed acknowledgement cho đúng quote và ghi nhận thời điểm theo cơ chế hiện có. Không nhận cart identity, giá, quyền nhận hoặc chữ ký tự tạo từ client.

### DATA-03 — Quote thay đổi và lỗi thực sự

Giữ `PRICE_CHANGED` và các kiểm tra stale/tampered/cross-cart proof. Khi quote đổi, không tự đặt lại đơn sau refresh và không mang chữ ký/acknowledgement cũ sang quote mới. Khách phải nhìn thấy thông báo và báo giá mới rồi chủ động gửi lại; không hiện thêm popup nhắc quà trong cùng lượt đã nhắc. Lần gửi mới là ý định mới với proof hiện tại, không phải replay đồng ý cũ.

Nếu quà đã chọn hết hàng/không còn hợp lệ, vẫn báo lỗi và yêu cầu khách sửa/bỏ lựa chọn đó; không âm thầm xóa, thay quà hoặc bỏ kiểm tra chỉ vì popup đã xuất hiện. Nếu hết hàng chỉ ở phần chưa chọn, không hứa cấp quà thiếu hoặc ghi thành khách tự từ chối dù còn hàng.

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
| AC-04 | Thẻ ảnh/fallback, nhãn, lựa chọn phiên bản và nhận/bỏ/giảm số quà đúng; không đoán thuộc tính từ chuỗi. |
| AC-05 | Không mua thêm hoặc đã dismiss upsell vẫn chọn được mọi quyền nhận hợp lệ, kể cả nhiều campaign. |
| AC-06 | Chưa chọn hoặc chọn một phần: submit hợp lệ lần đầu chỉ mở đúng một popup, không tạo đơn/giữ kho/gửi POS/purchase event. |
| AC-07 | “Vẫn đặt hàng” trong popup gửi đúng một đơn qua luồng chuẩn; không có popup/checkbox xác nhận thứ ba. |
| AC-08 | Đóng/X/Escape không gửi đơn; bấm đặt hàng tiếp theo không nhắc lại và được đi tiếp nếu các kiểm tra khác đạt. |
| AC-09 | Chọn quà từ popup không mất tên, điện thoại, địa chỉ, ghi chú; chọn xong hoặc chọn còn thiếu rồi đặt hàng không bị nhắc lại trong lượt. |
| AC-10 | Không có quyền nhận/đã chọn đủ/tier-only không popup; thông tin nhận hàng thiếu hoặc sai hiện lỗi trước, chưa đánh dấu đã nhắc. |
| AC-11 | Lưu quà lỗi, refresh đang chạy, upsell pending hoặc submit pending không cho gửi dữ liệu cũ; phục hồi xong không nhắc lặp. |
| AC-12 | Đổi lựa chọn, mua thêm, render lại hoặc retry lỗi có thể phục hồi giữ cờ đã nhắc trong lượt; thành công/giỏ khác/lượt mới không kế thừa cờ. |
| AC-13 | Reload cùng lượt khôi phục theo R-01; storage thiếu/hỏng theo fallback, không crash hoặc tạo xác nhận tự động. |
| AC-14 | Proof cũ/tampered/cross-cart vẫn bị từ chối; `PRICE_CHANGED` hiển thị quote mới, không tự resubmit, không replay ack cũ. |
| AC-15 | Thứ tự first reminder → second submit → server proof verification → acknowledgement → snapshot/order được chứng minh; không chỉ test biến boolean. |
| AC-16 | Quà đã chọn không hợp lệ không được bỏ qua; thiếu stock và chủ động không chọn có copy/snapshot đúng nguyên nhân. |
| AC-17 | Giới hạn entitlement, không trùng sản phẩm gốc, stock chung giữa campaign và paid/gift không bị yếu đi. |
| AC-18 | Double-click, Enter lặp, popup vừa mở và hai lối submit không tạo đơn trùng; kết quả POS chưa rõ không bị retry mù. |
| AC-19 | Modal dùng bàn phím được, focus vào/ra đúng, nền inert, nút có tên; không gửi đơn khi chỉ đóng hoặc chọn quà. |
| AC-20 | Kiểm tra 320/375/390/768/1024/1440px và zoom chữ 200%: không tràn ngang, không bị bàn phím/mobile viewport che CTA; vùng bấm khoảng 44px khi khả thi. |

Unit/domain: kiểm tra state machine, projection quyền nhận, parsing/claim, proof và các chuyển trạng thái. Tách logic điều phối đủ nhỏ để test bằng `node:test`, không mock thay engine quyền nhận.

Integration/database: kiểm tra snapshot/audit, reservation, lỗi quote và chống đơn trùng bằng môi trường test riêng. Update bài test mô tả checkbox sang hành động sau nhắc, nhưng giữ coverage bảo mật của strict parsing/proof. Tham khảo `tests/domain/guest-checkout-public-actions.test.ts`.

Browser: kiểm tra DOM thực, trạng thái modal, bàn phím/focus, responsive, nội dung form và network của hai lần bấm. Mã nguồn có chuỗi “popup” hay test snapshot HTML không thay thế được kiểm tra first-click không gửi request tạo đơn và second-click đi hết luồng. Chỉ chạy tạo đơn/POS với test fixture hoặc sandbox được cho phép, không dùng checkout production để thử.

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
| `src/components/headless/use-cart-gifts.ts` | Tái sử dụng mutation/pending; bổ sung phối hợp nếu cần, không tạo đường lưu song song. |
| `src/commerce/cart-gift-selection.ts`, `src/commerce/product-media.ts`, `src/routes/cart-gift-model.ts` | Bổ sung ảnh an toàn và dữ liệu hiển thị từ nguồn sản phẩm. |
| `src/app/cart/page.tsx`, `src/app/checkout/page.tsx` | Đặt khu vực quà dưới danh sách; giữ paid segments, totals và bố cục theo breakpoint. |
| `src/routes/checkout.ts`, `src/routes/checkout-model.ts` | Đưa toàn bộ dữ liệu picker/count vào checkout độc lập upsell, đồng bộ với quote đang hiển thị. |
| `src/components/commerce/guest-checkout-form.tsx`, `src/components/brand/guest-checkout-form.tsx` | Owner luồng submit, modal, lỗi form, dữ liệu nhận hàng và slots presentation. |
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

Tham khảo chính thức đã tra khi soạn spec: [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) cho focus/keyboard/nền inert; [Next.js Forms](https://nextjs.org/docs/app/guides/forms) cho form, validation và pending. Đây không phải bằng chứng đã chạy component trên Next `16.3.3`.

## 9. Ranh giới, rủi ro và quality gate

**Luôn làm:** giữ server authority; xác thực input/proof; bảo toàn dữ liệu form; test hành vi trước khi sửa logic; review diff đúng phạm vi; kiểm tra browser cho thay đổi giao diện; ghi rõ bằng chứng đã chạy/chưa chạy.

**Hỏi trước:** thay schema/snapshot/public API không tương thích, thêm dependency, đổi auth/storage nhạy cảm, CI, cơ chế retry hoặc tích hợp POS; thay các mặc định R-01..R-04 sau khi spec đã được duyệt.

**Không làm:** tự chọn/thay/xóa quà, default acknowledgement thành true, bỏ test bảo mật để pass, force-push main, commit secret/PII, tạo đơn thử production, hoặc gọi bản đặc tả là tính năng đã hoàn thành.

Rủi ro chính là trộn “đã nhắc” với “đã đồng ý quote”, bộ chọn bị khóa theo upsell, mount trùng ở hai breakpoint và hai đường submit tạo đơn trùng. Thiết kế state tách biệt và AC-05..AC-19 là các chốt kiểm soát. Không yêu cầu migration để chỉ ghi nhớ popup; mọi nhu cầu migration phát hiện khi build phải quay lại review.

Definition of Done cho implementation: AC-01..AC-20 đạt; unit/integration phù hợp, lint/typecheck/build đạt; kiểm tra browser và đường lỗi có bằng chứng; không hồi quy quote/stock/snapshot; cập nhật tài liệu cũ liên quan; review security và rollout/rollback của thay đổi checkout trước release. Không coi một bộ test xanh là đủ khi chưa xác minh runtime.

Gate của PR spec này: tài liệu bao phủ mục tiêu, trạng thái/luồng hai lần bấm, nguồn dữ liệu, commands, cấu trúc, style, test, boundaries và những điểm cần review; diff chỉ có tài liệu; người phụ trách duyệt spec trước `/plan` hoặc `/build`. Không tự chuyển sang implementation, merge hoặc deploy trong PR này.
