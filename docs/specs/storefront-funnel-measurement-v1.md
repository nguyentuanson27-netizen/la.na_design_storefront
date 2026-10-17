# Spec — Đo lường phễu cart → checkout (MEAS-FUNNEL-001)

**Ngày cập nhật:** 2026-10-17
**Trạng thái:** DRAFT v1.0 — spec-only, để owner review; chưa phê duyệt implementation, sink hay khóa tương quan.
**Baseline:** `main@c6058a1c938df31fcff04108da9cee8e8b4bca4d`.
**Quan hệ:** tách từ §8 của [storefront-promotion-upsell-checkout-ux-v1.md](storefront-promotion-upsell-checkout-ux-v1.md) (UX-COMMERCE-001) để phần UX được duyệt độc lập. Spec UX dùng chỉ số ở đây để đánh giá thay đổi (đặc biệt khuyến nghị B); spec này không đổi hợp đồng UX nào. Kế thừa contract [marketing-analytics-shopping.md](marketing-analytics-shopping.md) §4; điểm nào khác contract đó phải được duyệt như mở rộng contract.

Mục tiêu: có số đo **trước** (baseline hiện tại) và **sau** mỗi thay đổi UX, để owner đánh giá B và mọi quyết định A/B sau này bằng dữ liệu. Spec này định nghĩa loại event, nguồn hợp lệ, định danh và chỉ số; **không đặt chỉ tiêu** và không là kế hoạch GTM đã duyệt. Phần nào cần sink hoặc khóa tương quan mới chỉ được triển khai sau gate MEAS-06.

## MEAS-01 — Nguyên tắc chung (kế thừa `marketing-analytics-shopping.md` §4)

- **Không PII** trong mọi payload: không tên, SĐT, địa chỉ, ghi chú, nội dung hay giá trị trường form; không cookie `la_cart`, cart ID, `attemptKey` (HMAC theo cart) hay bất kỳ giá trị suy ra từ chúng.
- Không suy giá, entitlement, số suất hay trạng thái quà từ DOM/text; mọi giá trị trong payload lấy từ view model hoặc kết quả server.
- Fail-safe: lỗi tracking không chặn, không làm chậm checkout, không đổi kết quả mutation; thiếu dữ liệu an toàn thì bỏ event, không đoán.
- Tracking không là bước phân quyền: event không mở hay khóa bất kỳ thao tác nào.

## MEAS-02 — Hai loại event và nguồn hợp lệ

| Loại | Định nghĩa | Nguồn hợp lệ | Dedup |
| --- | --- | --- | --- |
| **Business event** | Kết quả thương mại đã xảy ra | Chỉ sau kết quả server đã xác nhận: committed mutation, readback, outcome submit, confirmed order | Một lần mỗi kết quả commit; reload/readback chỉ đọc lại trạng thái, **không phát lại**; kết quả chưa rõ không phát cho tới khi readback xác nhận |
| **UX observation** | Điều khách thấy hoặc làm trên UI | Sự kiện UI xảy ra trên một trạng thái do **server view model** cung cấp (offer hợp lệ, picker, popup, kết quả validation phía client). Đây là quan sát, **không phải kết quả server xác nhận** và không bao giờ được dùng làm conversion hay bằng chứng giao dịch | Theo MEAS-04: một lần mỗi phần tử hiển thị trong một lần tải trang; reload là lượt hiển thị mới và được đếm riêng, ghi rõ trong báo cáo |

Các event có sẵn trong `src/tracking/commerce-events.ts` theo đúng truth point của contract analytics: `view_cart`, `begin_checkout` là quan sát trạng thái cart/checkout đã resolve (canonical rendered facts); `add_to_cart`/`remove_from_cart` chỉ sau committed delta; `purchase` chỉ sau confirmed order. **Khoảng trống:** add từ checkout upsell hiện chưa phát `add_to_cart` (`checkout-upsell.tsx`, `promotion-upsell-actions.ts`); khi bổ sung, phát từ committed +1 trả về bởi action, không từ click.

## MEAS-03 — Danh sách event đề xuất (tên tạm, chốt khi implementation)

**Business events** — đi qua vocabulary commerce hiện có hoặc mở rộng có review:

| Event | Truth point | Payload tối thiểu |
| --- | --- | --- |
| `add_to_cart` (nguồn checkout upsell) | Action add trả về commit +1 | item canonical + ngữ cảnh nguồn nếu contract cho phép |
| `gift_selection_saved` / `gift_selection_removed` | Server xác nhận lưu/bỏ quà (kể cả qua readback sau mất phản hồi) | bề mặt (cart/checkout), campaign, số lượng thay đổi |
| `checkout_submit_outcome` | Server trả kết quả submit | thành công / giá đổi / thử lại được / kết thúc / chưa rõ |
| `purchase` | Confirmed order (không đổi) | như contract hiện có |

**UX observations** — chỉ qua sink UX riêng (MEAS-05):

| Event | Khi nào xảy ra | Payload tối thiểu |
| --- | --- | --- |
| `upsell_view` | Khối gợi ý hiển thị lần đầu với offer do server cung cấp, chưa dismiss | phương án (A/B), số ứng viên, vị trí; campaign lấy từ view model |
| `upsell_expand` | Chỉ B: khách mở phần thu gọn | phương án |
| `upsell_dismiss` | Khách chọn “Không mua thêm” | phương án |
| `upsell_exit_to_sale` | Chỉ A: khách đi theo link `/sale` | form đã có dữ liệu hay chưa (boolean, không giá trị) |
| `gift_reminder_shown` / `gift_reminder_outcome` | Popup UX-10 mở / khách chọn | nhánh `canChoose` true/false/hỗn hợp từ model; outcome chọn quà / vẫn đặt / đóng |
| `checkout_submit_blocked` | Submit bị chặn trước khi gửi (validation client hoặc trạng thái khóa) | lớp lý do: thiếu trường (chỉ **tên trường**), quote/proof chưa sẵn sàng, đang chờ quà/upsell/báo giá, lỗi địa chỉ |

## MEAS-04 — Định danh, ghép event, attribution và dedup

Hiện **chưa có khóa tương quan nào được duyệt** cho analytics. Vì vậy:

- **Không** dùng `la_cart`, cart ID, HMAC từ cart (`attemptKey`), số điện thoại hay mã đơn để ghép UX observation với giao dịch; `publicCode` chỉ là identity của `purchase` như contract hiện có.
- **Đề xuất cần owner duyệt (MEAS-06):** một **khóa lượt checkout ngẫu nhiên, không suy ra từ dữ liệu nào** (ví dụ UUID sinh ở client khi vào checkout, sống trong phạm vi tab, xóa khi hoàn tất đơn hoặc rời lượt). Khóa chỉ dùng để ghép event trong cùng lượt, không gửi cho vendor quảng cáo nếu chưa duyệt, tuân theo consent abstraction trong `src/tracking/consent.ts`.
- **Cửa sổ attribution** (đề xuất mặc định, owner chốt): một lượt checkout trong cùng tab, tối đa 24 giờ. Event ngoài cửa sổ không ghép.
- **Confirm POS bất đồng bộ:** chỉ `purchase` đã xác nhận mới tính là hoàn tất. Đơn đang xử lý hoặc kết quả chưa rõ không tính; nếu xác nhận đến sau khi lượt đã đóng hoặc ngoài cửa sổ, đơn được tính trong tỉ lệ tổng hợp theo kỳ nhưng **không** được ghép vào lượt. Không tự phát `purchase` từ UI.
- **Dedup UX observation:** `upsell_view`, `gift_reminder_shown` một lần mỗi phần tử trong một lần tải trang; `upsell_expand`/`upsell_dismiss`/`gift_reminder_outcome` một lần mỗi hành động; quay lại trang hoặc reload là lần hiển thị mới. Không phát lại khi model chỉ refresh quote mà phần tử vẫn đang hiển thị.

## MEAS-05 — Sink và schema

- `src/tracking/event-boundary.ts` hiện chỉ nhận vocabulary commerce đóng và **từ chối** mọi tên khác. UX observation **không** được đi qua boundary này bằng cách nới vocabulary commerce.
- Cần một **boundary UX riêng** với vocabulary đóng, schema từng event, field set cố định và cùng nguyên tắc canonicalize (bỏ field lạ, field sai thì fail closed). Định tuyến (GA4 custom event, sink first-party hay chỉ log nội bộ) là quyết định MEAS-06; mặc định không map sang conversion quảng cáo.
- Business event mới (`gift_selection_*`, `checkout_submit_outcome`) cần review như mở rộng contract commerce, hoặc đưa vào boundary UX nếu owner quyết định không gửi vendor.

## MEAS-06 — Gate đo lường và chỉ số theo mức sẵn sàng (OD-02 trong spec UX)

Owner duyệt trước khi triển khai phần tương ứng: (1) sink/schema UX và nơi lưu; (2) khóa lượt ngẫu nhiên, phạm vi, thời hạn và quan hệ với consent; (3) cửa sổ attribution. Khi chưa duyệt, chỉ đo **Mức 0**.

| ID | Chỉ số | Cách tính | Mức |
| --- | --- | --- | --- |
| M-01 | Cart → checkout | số `begin_checkout` / số `view_cart` theo kỳ (tỉ lệ tổng hợp, không ghép) | 0 |
| M-02 | Hoàn tất checkout | số `purchase` đã xác nhận / số `begin_checkout` theo kỳ — **guardrail chính** | 0 (tổng hợp); 1 nếu tính theo lượt |
| M-05 | Giá trị và số món mỗi đơn | từ order snapshot / `purchase` theo kỳ; tách đơn có add upsell chỉ khi snapshot ghi nguồn dòng (chưa có, cần duyệt) | 0 (tổng); 1 (tách) |
| M-08 | An toàn | đơn trùng, outcome chưa rõ, lỗi add/requote từ dữ liệu server/vận hành, không từ UX event | 0 |
| M-03 | Tỉ lệ thêm từ upsell | add upsell đã commit / `upsell_view` trong cùng lượt; kèm tỉ lệ dismiss, expand (B) | 1 |
| M-04 | Hoàn tất khi có upsell | M-02 theo lượt, tách lượt có / không `upsell_view` (quan sát, có thiên lệch — không suy nhân quả) | 1 |
| M-06 | Nhận đủ quà | đơn chọn đủ suất / đơn có suất (Mức 0 từ order snapshot); popup → chọn quà theo lượt (Mức 1) | 0 / 1 |
| M-07 | Ma sát submit | `checkout_submit_blocked` theo lý do mỗi lượt; tần suất giá đổi | 1 |

**Mức 0:** tính được từ event commerce và dữ liệu đơn hiện có, không cần khóa tương quan hay sink mới. **Mức 1:** cần gate MEAS-06 đã duyệt và đã chạy trước khi đổi UI để có baseline.

## MEAS-07 — So sánh và quyết định

- Thu baseline **Mức 0** trên `main` hiện tại trước khi đổi upsell. Nếu owner muốn đánh giá B bằng M-03/M-04, triển khai sink/khóa Mức 1 **trước** thay đổi UI, đủ thời gian để có baseline.
- Owner chọn độ dài cửa sổ baseline (đủ số lượt checkout để ổn định), tránh trùng đợt sale lớn hoặc ghi rõ khi trùng.
- Mặc định so sánh **trước/sau** cho B. Chia ngẫu nhiên theo lượt cần quyết định riêng về flag và đủ lưu lượng; PR này không thêm feature flag.
- Báo cáo nêu số mẫu, khoảng thời gian, mức chỉ số và các thay đổi khác cùng lúc; không kết luận khi mẫu quá nhỏ.

## Acceptance Criteria — dành cho PR implementation sau khi duyệt

| ID | Kịch bản | Kết quả chấp nhận |
| --- | --- | --- |
| MEAS-AC-01 | **Business event**: add upsell, lưu/bỏ quà, outcome submit, purchase; reload, readback, mất phản hồi, POS chưa rõ, tracking lỗi | Mỗi kết quả commit phát đúng một lần, chỉ sau xác nhận server; readback/reload không phát lại; kết quả chưa rõ không phát cho tới khi xác nhận; không phát `purchase` từ UI; payload không PII, không `la_cart`/cart ID/`attemptKey`; tracking lỗi không chặn hay đổi checkout |
| MEAS-AC-02 | **UX observation**, chỉ sau gate MEAS-06: view/expand/dismiss upsell, popup, submit bị chặn; reload, refresh quote, sink từ chối | Đi qua boundary UX riêng, không nới vocabulary commerce; payload chỉ lấy từ view model/kết quả validation, không giá/entitlement từ DOM, không giá trị trường form; dedup đúng MEAS-04; khóa lượt (nếu duyệt) ngẫu nhiên, không suy ra từ cart/PII; không bị dùng làm conversion |

Dùng fixture isolated/test DB; không tạo đơn production để nghiệm thu. Không suy pass từ source hoặc kết quả của PR khác.

## Code ownership

- `src/tracking/commerce-events.ts`, `event-boundary.ts`, `consent.ts`, `src/components/analytics/`: business event theo contract hiện có; UX observation qua boundary UX riêng (MEAS-05), không định tuyến vendor khi chưa duyệt.
- Điểm phát event business: `src/commerce/promotion-upsell-actions.ts` (add upsell), `src/commerce/cart-gift-selection-actions.ts` (lưu/bỏ quà), `src/commerce/guest-checkout-actions.ts` (outcome submit), luồng confirmed order (`purchase`).

## Review checklist

- [ ] Không có PII, cookie `la_cart`, cart ID hay `attemptKey` trong payload hay khóa ghép.
- [ ] Business event và UX observation tách nguồn, dedup; UX observation không bao giờ là conversion.
- [ ] `event-boundary.ts` giữ vocabulary đóng; UX observation có boundary/schema riêng.
- [ ] Không đặt chỉ tiêu; chỉ số ghi rõ Mức 0 / Mức 1 và gate MEAS-06.
- [ ] Owner duyệt gate MEAS-06 (sink/schema UX, khóa lượt và consent, cửa sổ attribution) trước khi triển khai Mức 1.
