# Spec — Đo lường phễu cart → checkout (MEAS-FUNNEL-001)

**Ngày cập nhật:** 2026-10-17
**Trạng thái:** v1.4 — owner chốt OD-02 ngày 17/10/2026: **chỉ đo Mức 0**. Sink UX, khóa lượt, binding lượt ↔ đơn và đăng ký lượt (MEAS-04a/b/c, MEAS-05, MEAS-AC-02..05) **không triển khai**; giữ làm đặc tả cho lần duyệt sau. Upsell checkout theo phương án A không còn thao tác add tại checkout, nên khoảng trống `add_to_cart` ở MEAS-02 không còn áp dụng.
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
| **Business event** | Kết quả thương mại đã xảy ra | Chỉ sau kết quả server đã xác nhận: committed mutation, readback, outcome submit, confirmed order | Tách **phát** và **đếm** (MEAS-02a). Không hứa exactly-once delivery ở client |
| **UX observation** | Điều khách thấy hoặc làm trên UI | Sự kiện UI xảy ra trên một trạng thái do **server view model** cung cấp (offer hợp lệ, picker, popup, kết quả validation phía client). Đây là quan sát, **không phải kết quả server xác nhận** và không bao giờ được dùng làm conversion hay bằng chứng giao dịch | Theo MEAS-04: một lần mỗi phần tử hiển thị trong một lần tải trang; reload là lượt hiển thị mới và được đếm riêng, ghi rõ trong báo cáo |

### MEAS-02a — Phát (emission) khác với đếm giao dịch duy nhất (counting)

- **Không hứa exactly-once delivery.** `CommerceEventPublisher` (`src/components/analytics/commerce-event-publisher.tsx`) chỉ chống trùng trong vòng đời component; `src/routes/checkout-success.ts` dựng lại `purchase` từ đơn `CONFIRMED` mỗi lần trang thành công được tải. Reload, mở lại tab hay quay lại trang có thể phát lại cùng một event.
- **`purchase`:** có thể được phát lại khi trang thành công tải lại. Đếm giao dịch duy nhất dựa trên identity bền `publicCode` (`transaction_id = event_id`) như contract hiện có: vendor dedup theo `event_id`; báo cáo first-party đếm theo identity đơn, không theo số lần phát. Không thêm cơ chế "đã phát" ở client hay storage nếu chưa đặc tả và duyệt một cơ chế bền.
- **Event không có identity bền** (`add_to_cart` upsell, `gift_selection_*`, `checkout_submit_outcome` cho kết quả **không thành công**): chỉ phát từ **phản hồi xác nhận của chính action** trong vòng đời trang đó. Readback sau mất phản hồi, reload hay refresh quote **không** phát bù, vì không phân biệt được commit nào đã xảy ra; chấp nhận đếm thiếu và theo dõi các ca đó qua M-08 (dữ liệu server). Các chỉ số dùng event này phải ghi rõ là số **lần phát quan sát được**, không phải số mutation chính xác.
- **Submit thành công không có phản hồi ở trang checkout:** `src/commerce/guest-checkout-actions.ts` `redirect` sang `/checkout/success?order=…` ngay khi đơn được tạo, nên form (`useActionState`) không nhận state thành công. Vì vậy `checkout_submit_outcome` **không** có giá trị “thành công”. Tín hiệu thành công tách hai bước: (a) **binding lượt ↔ đơn ghi phía server** ngay khi pipeline submit đã xác định đơn của lần submit này — gồm cả kết quả `PROCESSING`, `SYNC_UNKNOWN` (`ok:false` nhưng có `orderCode`) và `RETRYABLE` có `orderCode` (MEAS-04b); (b) **conversion** chỉ khi dữ liệu server cho thấy đơn đó `CONFIRMED` trong cửa sổ attribution. `purchase` ở trang thành công vẫn theo contract hiện có nhưng không phải nguồn của M-02c. Reload trang thành công không tạo thêm binding.
- Số chính xác về đơn, dòng hàng và quà luôn lấy từ dữ liệu server/order snapshot, không từ đếm event.

Các event có sẵn trong `src/tracking/commerce-events.ts` theo đúng truth point của contract analytics: `view_cart`, `begin_checkout` là quan sát trạng thái cart/checkout đã resolve (canonical rendered facts); `add_to_cart`/`remove_from_cart` chỉ sau committed delta; `purchase` chỉ sau confirmed order. **Khoảng trống:** add từ checkout upsell hiện chưa phát `add_to_cart` (`checkout-upsell.tsx`, `promotion-upsell-actions.ts`); khi bổ sung, phát từ committed +1 trả về bởi action, không từ click.

## MEAS-03 — Danh sách event đề xuất (tên tạm, chốt khi implementation)

**Business events** — đi qua vocabulary commerce hiện có hoặc mở rộng có review:

| Event | Truth point | Payload tối thiểu |
| --- | --- | --- |
| `add_to_cart` (nguồn checkout upsell) | Action add trả về commit +1 | item canonical + ngữ cảnh nguồn nếu contract cho phép |
| `gift_selection_saved` / `gift_selection_removed` | Phản hồi xác nhận lưu/bỏ quà của chính action (readback không phát bù, MEAS-02a) | bề mặt (cart/checkout), campaign, số lượng thay đổi |
| `checkout_submit_outcome` | Server trả kết quả submit **không thành công** về form (thành công là `redirect`, xem MEAS-02a) | giá đổi / thử lại được / kết thúc / chưa rõ |
| `purchase` | Confirmed order (không đổi); có thể phát lại khi trang thành công tải lại | như contract hiện có; đếm duy nhất theo `publicCode` |

**UX observations** — chỉ qua sink UX riêng (MEAS-05):

| Event | Khi nào xảy ra | Payload tối thiểu |
| --- | --- | --- |
| `checkout_visit_started` | Trang checkout render với giỏ không rỗng (thường / benefit / `unquotable`), một lần mỗi khóa lượt — mẫu số của M-02c (MEAS-04c) | khóa lượt, loại checkout, có offer upsell / có suất quà (boolean) |
| `upsell_view` | Khối gợi ý hiển thị lần đầu với offer do server cung cấp, chưa dismiss | phương án (A/B), số ứng viên, vị trí; campaign lấy từ view model |
| `upsell_expand` | Chỉ B: khách mở phần thu gọn | phương án |
| `upsell_dismiss` | Khách chọn “Không mua thêm” | phương án |
| `upsell_exit_to_sale` | Chỉ A: khách đi theo link `/sale` | form đã có dữ liệu hay chưa (boolean, không giá trị) |
| `gift_reminder_shown` / `gift_reminder_outcome` | Popup UX-10 mở / khách chọn | nhánh `canChoose` true/false/hỗn hợp từ model; outcome chọn quà / vẫn đặt / đóng |
| `checkout_submit_blocked` | Submit bị chặn trước khi gửi (validation client hoặc trạng thái khóa) | lớp lý do: thiếu trường (chỉ **tên trường**), quote/proof chưa sẵn sàng, đang chờ quà/upsell/báo giá, lỗi địa chỉ |

## MEAS-04 — Định danh, ghép event, attribution và dedup

Hiện **chưa có khóa tương quan nào được duyệt** cho analytics. Vì vậy:

- **Không** dùng `la_cart`, cart ID, HMAC từ cart (`attemptKey`) hay số điện thoại để ghép. `publicCode` là identity của `purchase` trong contract vendor; trong sink first-party nó chỉ xuất hiện dưới dạng HMAC phía server (MEAS-04a), cùng nguyên tắc với tra cứu đơn khách (`guest-order-tracking.md`: không lưu hay log mã đơn thô).
- **Đề xuất cần owner duyệt (MEAS-06):** một **khóa lượt checkout ngẫu nhiên, không suy ra từ dữ liệu nào** (ví dụ UUID sinh ở client khi vào checkout, sống trong phạm vi tab; vòng đời và thời điểm thay khóa theo MEAS-04c). Khóa chỉ dùng để ghép event trong cùng lượt, không gửi cho vendor quảng cáo nếu chưa duyệt, tuân theo consent abstraction trong `src/tracking/consent.ts`.
- **Cửa sổ attribution** (đề xuất mặc định, owner chốt): 24 giờ tính từ **thời điểm đăng ký lượt** phía server (MEAS-04c). Hạn này do server tính, **không phụ thuộc tab còn mở**: đóng tab chỉ làm client ngừng gửi bản ghi, không đóng lượt. Bản ghi hay xác nhận đơn sau hạn không ghép vào lượt.
- **Confirm POS bất đồng bộ:** chỉ `purchase` đã xác nhận mới tính là hoàn tất. Đơn đang xử lý hoặc kết quả chưa rõ không tính; nếu xác nhận đến sau hạn cửa sổ của lượt, đơn được tính trong tỉ lệ tổng hợp theo kỳ nhưng **không** tăng tử số M-02c. Không tự phát `purchase` từ UI.
- **MEAS-04a — Ghép kết quả server với lượt UX (chỉ ở sink first-party, sau OD-02):**
  - Khóa lượt chỉ đi trong bản ghi gửi tới **sink first-party** và, riêng cho MEAS-04b, trong một trường đo lường của form đặt hàng; **không bao giờ** nằm trong payload commerce/vendor (`dataLayer`, GA4 ecommerce, Meta/TikTok), trong dữ liệu đơn/POS/Pancake hay trong các action khác.
  - Khi trang nhận phản hồi xác nhận của một action (add upsell, lưu/bỏ quà, outcome submit), trang gửi thêm một **bản ghi kết quả** tới sink first-party gồm khóa lượt, loại kết quả và một **mã thao tác ngẫu nhiên** sinh ở client trước khi gọi action. Sink dedup theo (khóa lượt, mã thao tác); readback không tạo bản ghi.
  - Hoàn tất: **không** lấy từ bản ghi trình duyệt gửi ở trang thành công. Trang thành công chỉ tra `publicCode` từ URL và kiểm tra `CONFIRMED` (`src/routes/checkout-success.ts`), không chứng minh lượt nào đã tạo đơn; HMAC chỉ bảo vệ dữ liệu lưu. Hoàn tất dùng binding phía server ở MEAS-04b. Đơn chỉ tính hoàn tất khi đơn đó ở trạng thái `CONFIRMED` trong dữ liệu server; xác nhận đến sau cửa sổ attribution không ghép.
- **MEAS-04b — Binding lượt ↔ đơn phía server (server-authoritative):**
  - Khi submit, form gửi kèm khóa lượt trong một trường đo lường riêng (chỉ khi consent `granted`). Action đặt hàng **không** dùng trường này cho bất kỳ quyết định thương mại nào và không ghi nó vào đơn, snapshot, POS hay log.
  - **Điểm ghi binding:** ngay khi pipeline submit phía server đã xác định đơn thuộc lần submit này — tức mọi kết quả mang `orderCode` do server tạo cho submit đó: `CONFIRMED` (`ok:true`), `PROCESSING`, `SYNC_UNKNOWN` và `RETRYABLE` có `orderCode` (`src/commerce/guest-checkout-submit.ts`) — server ghi **một** bản ghi binding vào kho đo lường first-party: (định danh đơn nội bộ hoặc HMAC của nó, khóa lượt, thời điểm), trước khi trả kết quả hay `redirect`. Không chỉ ở nhánh `result.ok`, vì đơn `PROCESSING`/`SYNC_UNKNOWN` có thể được đối soát thành `CONFIRMED` sau đó mà khách không submit lại hay tải trang thành công. **Ràng buộc duy nhất theo đơn**: một đơn quy thuộc tối đa một lượt; ghi lần hai cho cùng đơn (submit lại, tab khác) bị bỏ qua, không ghi đè. Binding **không** phải conversion và không phát `purchase` sớm. Lỗi ghi binding không ảnh hưởng đơn, kết quả trả về hay `redirect`. Mã đơn do trình duyệt khai báo không bao giờ là chứng cứ binding.
  - **Conversion là bước riêng:** tử số M-02c chỉ đếm lượt có binding tới đơn mà dữ liệu server ghi `CONFIRMED` trước hạn cửa sổ của lượt (đối soát định kỳ hoặc khi trạng thái đơn đổi, không chờ trình duyệt). Đơn không có binding (khách từ chối consent, lỗi ghi, đơn tạo ngoài luồng) không tăng tử số; mã đơn đưa vào từ trình duyệt không thể tạo binding.
  - Nếu chưa triển khai MEAS-04b, mọi số hoàn tất theo lượt phải gắn nhãn **client-observed** và **không** được dùng làm guardrail conversion chính.
- **MEAS-04c — Đăng ký lượt (mẫu số của M-02c, M-04):**
  - **Bản ghi `checkout_visit_started`** (first-party, sau OD-02): khi trang checkout render với giỏ không rỗng — gồm checkout thường, benefit checkout và checkout `unquotable` — và consent `granted`, client sinh (hoặc đọc lại) khóa lượt và gửi một bản ghi đăng ký: (khóa lượt, loại checkout: thường/benefit/unquotable, có offer upsell hay không, có suất quà hay không). Server ghi **thời điểm đăng ký** làm mốc cửa sổ attribution. Không phụ thuộc khách có tương tác hay không, nên lượt vào rồi bỏ ngay vẫn nằm trong mẫu.
  - **Không** dùng `begin_checkout` hay event vendor làm mẫu số: các event đó không mang khóa lượt, và `src/routes/checkout.ts` chủ động không phát event funnel cho benefit checkout.
  - **Khóa lượt và dedup:** khóa sống trong phạm vi tab (`sessionStorage`; khóa ngẫu nhiên không phải PII); reload hay quay lại checkout trong cùng tab dùng lại khóa và sink dedup theo khóa, nên không tăng mẫu số. Khóa mới chỉ khi lượt trước đã có binding, đã quá hạn cửa sổ, hoặc ở tab mới.
  - **Tập hợp:** mẫu số = lượt đăng ký hợp lệ; tử số là **tập con của cùng cohort** (lượt đã đăng ký có binding tới đơn `CONFIRMED` trước hạn). Binding có khóa chưa từng đăng ký (mất bản ghi đầu lượt) **không** vào tử số và được báo riêng là “hoàn tất không có đăng ký lượt”; số lượt đăng ký được đối chiếu thô với số lượt render checkout phía server theo kỳ để phát hiện mất bản ghi, không coi mẫu quan sát được là toàn bộ lượt checkout.
- **Consent (cho MEAS-04a/04b/04c):**
  - Chỉ tạo khóa lượt và gửi bản ghi khi tín hiệu consent cho đo lường là `granted` theo `src/tracking/consent.ts`; khi `denied`, không tạo khóa, xóa khóa đang có và không gửi bản ghi.
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
| M-02 | Tỉ số hoàn tất **tổng hợp tham khảo** | số đơn `CONFIRMED` duy nhất (theo identity đơn, dữ liệu server) / số `begin_checkout` theo kỳ. Không cùng cohort: xác nhận có thể rơi sang kỳ khác, reload/quay lại checkout tạo nhiều `begin_checkout`. **Chỉ để theo dõi xu hướng, không dùng riêng làm guardrail** | 0 |
| M-02c | Hoàn tất theo cohort lượt | số lượt **đã đăng ký** (MEAS-04c) có binding phía server (MEAS-04b) tới một đơn `CONFIRMED` trước hạn cửa sổ / số lượt đã đăng ký (mỗi khóa đếm một lần dù reload; mỗi đơn quy thuộc tối đa một lượt). Báo kèm theo loại checkout và số “hoàn tất không có đăng ký lượt”. **Guardrail conversion chính** khi đánh giá B — chỉ khi MEAS-04b và MEAS-04c đã triển khai; nếu không thì là chỉ số client-observed, không làm guardrail | 1 |
| M-05 | Giá trị và số món mỗi đơn | từ order snapshot / `purchase` theo kỳ; tách đơn có add upsell chỉ khi snapshot ghi nguồn dòng (chưa có, cần duyệt) | 0 (tổng); 1 (tách) |
| M-08 | An toàn | đơn trùng, outcome chưa rõ, lỗi add/requote từ dữ liệu server/vận hành, không từ UX event. **Guardrail Mức 0 đáng tin**: vượt ngưỡng là dừng rollout bất kể chỉ số khác | 0 |
| M-03a | Tỉ lệ lượt có thêm từ upsell | số lượt có **cả** `upsell_view` **và** ≥1 bản ghi kết quả add upsell / số lượt có `upsell_view` (tử số là tập con của mẫu nên luôn 0–100%); kèm tỉ lệ lượt dismiss, expand (B). Báo riêng **số lượt có add nhưng không thấy view** (dấu hiệu mất observation), không cộng vào M-03a | 1 |
| M-03b | Số món thêm mỗi lượt xem | tổng bản ghi kết quả add upsell **trong các lượt có `upsell_view`** / số lượt có `upsell_view` (có thể > 1); chỉ đọc cùng M-03a | 1 |
| M-04 | Hoàn tất khi có upsell | M-02c tách lượt đã đăng ký có / không `upsell_view` (lượt không tương tác thuộc nhóm “không”) (quan sát, có thiên lệch — không suy nhân quả) | 1 |
| M-06 | Nhận đủ quà | đơn chọn đủ suất / đơn có suất (Mức 0 từ order snapshot, số chính xác); lượt có popup → lượt có bản ghi lưu quà sau đó (Mức 1) | 0 / 1 |
| M-07 | Ma sát submit | `checkout_submit_blocked` theo lý do mỗi lượt; tần suất giá đổi | 1 |

**Mức 0:** tính được từ event commerce và dữ liệu đơn hiện có, không cần khóa tương quan hay sink mới; chỉ là tỉ số tổng hợp hoặc số đếm server, không phải tỉ lệ cohort. **Mức 1:** cần gate MEAS-06 đã duyệt và đã chạy trước khi đổi UI để có baseline.

## MEAS-07 — So sánh và quyết định

- Thu baseline **Mức 0** trên `main` hiện tại trước khi đổi upsell. Nếu quyết định rollout B dựa trên tỉ lệ hoàn tất, cần **M-02c** (Mức 1): triển khai sink/khóa **trước** thay đổi UI, đủ thời gian để có baseline. Nếu không có Mức 1, quyết định dựa trên M-08 cùng xu hướng Mức 0 và phải ghi rõ đây là bằng chứng hạn chế, không phải tỉ lệ hoàn tất đã đo.
- Owner chọn độ dài cửa sổ baseline (đủ số lượt checkout để ổn định), tránh trùng đợt sale lớn hoặc ghi rõ khi trùng.
- Mặc định so sánh **trước/sau** cho B. Chia ngẫu nhiên theo lượt cần quyết định riêng về flag và đủ lưu lượng; PR này không thêm feature flag.
- Báo cáo nêu số mẫu, khoảng thời gian, mức chỉ số và các thay đổi khác cùng lúc; không kết luận khi mẫu quá nhỏ.

## Acceptance Criteria — dành cho PR implementation sau khi duyệt

| ID | Kịch bản | Kết quả chấp nhận |
| --- | --- | --- |
| MEAS-AC-01 | **Business event**: add upsell, lưu/bỏ quà, outcome submit không thành công, submit thành công (redirect), purchase; reload, readback, mất phản hồi, POS chưa rõ, tracking lỗi | Event không có identity bền chỉ phát từ phản hồi xác nhận của chính action; `checkout_submit_outcome` không có giá trị thành công, submit thành công chỉ tạo binding phía server (nếu có MEAS-04b) và `purchase` khi đơn `CONFIRMED`; readback/refresh quote không phát bù; `purchase` chỉ từ đơn `CONFIRMED`, reload trang thành công có thể phát lại nhưng mang cùng `transaction_id = event_id = publicCode`, và báo cáo đếm duy nhất theo identity đơn; không phát `purchase` từ UI; payload không PII, không `la_cart`/cart ID/`attemptKey`; tracking lỗi không chặn hay đổi checkout |
| MEAS-AC-02 | **UX observation**, chỉ sau gate MEAS-06: view/expand/dismiss upsell, popup, submit bị chặn; reload, refresh quote, sink từ chối | Đi qua boundary UX riêng, không nới vocabulary commerce; payload chỉ lấy từ view model/kết quả validation, không giá/entitlement từ DOM, không giá trị trường form; dedup đúng MEAS-04; khóa lượt (nếu duyệt) ngẫu nhiên, không suy ra từ cart/PII; không bị dùng làm conversion |
| MEAS-AC-03 | **Ghép lượt** (MEAS-04a), chỉ sau gate MEAS-06: xem upsell → add 2 món → đặt hàng → reload trang thành công; mất phản hồi add rồi readback; consent `denied`; xác nhận POS đến sau cửa sổ | Khóa lượt không xuất hiện trong payload vendor/commerce, dữ liệu đơn/POS hay log; sink dedup theo (khóa, mã thao tác); mã đơn thô không được lưu hay log; readback không tạo bản ghi; M-03a của lượt = 100%, M-03b = 2; add có ghi nhưng view thất lạc không làm M-03a > 100% mà xuất hiện ở số “add không có view”; consent `denied` không tạo khóa/bản ghi; xác nhận ngoài cửa sổ không ghép vào lượt |
| MEAS-AC-04 | **Binding lượt ↔ đơn** (MEAS-04b), chỉ sau gate MEAS-06: đặt hàng thành công rồi reload trang thành công; cùng một mã đơn được gửi từ hai khóa lượt khác nhau; mở trang thành công bằng mã đơn không thuộc lượt; lỗi ghi binding; POS chưa rõ rồi xác nhận trong / ngoài cửa sổ; submit trả `PROCESSING` hoặc `SYNC_UNKNOWN`, khách không submit lại và không tải trang thành công, server đối soát thành `CONFIRMED` trong cửa sổ / ngoài cửa sổ; submit lại cùng đơn từ tab khác | Binding được ghi phía server ngay khi submit xác định đơn (kể cả `PROCESSING`/`SYNC_UNKNOWN`/`RETRYABLE` có `orderCode`), một đơn tối đa một lượt, ghi lần hai bị bỏ qua; binding và conversion là hai bước: ca `PROCESSING`/`SYNC_UNKNOWN` xác nhận trong cửa sổ cho đúng một lượt hoàn tất, ngoài cửa sổ không tăng tử số; reload và mã đơn gửi từ trình duyệt **không tăng tử số** M-02c; lỗi ghi binding không ảnh hưởng đơn hay `redirect`; đơn chỉ được tính khi `CONFIRMED` trong cửa sổ; trường đo lường không xuất hiện trong đơn, snapshot, POS hay log; không phát `purchase` trước khi đơn `CONFIRMED` |
| MEAS-AC-05 | **Đăng ký lượt** (MEAS-04c), chỉ sau gate MEAS-06: hai lượt có consent, đều không có upsell/quà — một lượt vào rồi bỏ ngay, một lượt đặt đơn được xác nhận; reload cùng lượt; benefit checkout và checkout `unquotable`; consent `denied`; mất bản ghi đăng ký nhưng có binding; đóng tab trước khi đơn xác nhận trong cửa sổ | Mẫu số 2, tử số 1; reload không tăng mẫu số; benefit/unquotable được đăng ký với đúng loại; consent `denied` không tạo khóa hay bản ghi; binding không có đăng ký không vào tử số mà vào số “hoàn tất không có đăng ký lượt”; đóng tab không làm mất hoàn tất nếu đơn `CONFIRMED` trước hạn tính từ thời điểm đăng ký |

Dùng fixture isolated/test DB; không tạo đơn production để nghiệm thu. Không suy pass từ source hoặc kết quả của PR khác.

## Code ownership

- `src/tracking/commerce-events.ts`, `event-boundary.ts`, `consent.ts`, `src/components/analytics/`: business event theo contract hiện có; UX observation qua boundary UX riêng (MEAS-05), không định tuyến vendor khi chưa duyệt.
- Điểm phát event business: `src/commerce/promotion-upsell-actions.ts` (add upsell), `src/commerce/cart-gift-selection-actions.ts` (lưu/bỏ quà), `src/commerce/guest-checkout-actions.ts` (outcome submit không thành công; binding MEAS-04b khi server xác định đơn thuộc lần submit, trước khi trả kết quả hoặc `redirect`), luồng confirmed order (`purchase`).

## Review checklist

- [ ] Không có PII, cookie `la_cart`, cart ID hay `attemptKey` trong payload hay khóa ghép.
- [ ] Business event và UX observation tách nguồn; phát và đếm tách nhau (MEAS-02a), không hứa exactly-once ở client; UX observation không bao giờ là conversion.
- [ ] M-02 ghi là tỉ số tham khảo; guardrail hoàn tất là M-02c (Mức 1) hoặc M-08; M-03a/M-03b định nghĩa rõ.
- [ ] Ghép lượt chỉ ở sink first-party, khóa không vào payload vendor, mã đơn chỉ dạng HMAC, có consent.
- [ ] Hoàn tất theo lượt dựa trên binding phía server (một đơn tối đa một lượt), ghi ngay khi submit xác định đơn kể cả `PROCESSING`/`SYNC_UNKNOWN`; conversion là bước riêng khi đơn `CONFIRMED`; không có binding thì gắn nhãn client-observed, không làm guardrail.
- [ ] Mẫu số M-02c/M-04 lấy từ bản ghi đăng ký lượt (`checkout_visit_started`), gồm cả lượt không tương tác và benefit checkout; tử số là tập con cùng cohort; hạn cửa sổ tính từ thời điểm đăng ký phía server.
- [ ] Submit thành công không có `checkout_submit_outcome`; truth point thành công là binding phía server và `purchase` từ đơn `CONFIRMED`.
- [ ] `event-boundary.ts` giữ vocabulary đóng; UX observation có boundary/schema riêng.
- [ ] Không đặt chỉ tiêu; chỉ số ghi rõ Mức 0 / Mức 1 và gate MEAS-06.
- [ ] Owner duyệt gate MEAS-06 (sink/schema UX, khóa lượt và consent, cửa sổ attribution) trước khi triển khai Mức 1.
