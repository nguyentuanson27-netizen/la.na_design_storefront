# Todo — Chọn quà tại chỗ và nhắc một lần

**Trạng thái:** Đã duyệt qua PR #174; implementation ở [PR #175](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/175), đang nghiệm thu. Các checkbox chỉ đóng khi có evidence.
**Plan:** [storefront-gift-picker-checkout-reminder-plan.md](storefront-gift-picker-checkout-reminder-plan.md), mục “Tiếp thu review UX” ghi quyết định UX-01..UX-04.  
**Spec gốc đã merge:** [PR #173](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/173), baseline `6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646`. [Spec bổ sung trong PR #174](../docs/specs/storefront-gift-picker-checkout-reminder.md) thêm AC-25..AC-28 sau review `87b7cd5`, đã được owner duyệt cùng plan; xem PR #174 và yêu cầu triển khai ngày 16/10/2026.

Tất cả lệnh bên dưới là bước cần chạy khi triển khai, không phải kết quả đã chạy trong PR plan. Tests dùng database/fixture riêng theo plan mục 5. File ghi “mới” là tên dự kiến; kiểm tra tiện ích hiện có trước khi thêm. Mỗi task hành vi đi RED → GREEN → review; không đánh dấu xong chỉ từ source inspection. Giữ 14 task; nghiệm thu UX được gắn vào task hiện có, không dồn quyết định spec tới T13.

## T00 — Xác lập baseline kiểm thử

**Mục tiêu:** xác nhận môi trường an toàn và phân loại CI hiện có trước khi thêm hành vi.
**Phụ thuộc:** không; cần người phụ trách duyệt plan và bổ sung spec UX. **Scope:** S, 1 file evidence dự kiến.
**Files:** `docs/verification/storefront-gift-picker-checkout-reminder.md` (mới).
**Nghiệm thu:**
- [ ] Ghi SHA, env test, commands và kết quả thật; không dùng DB/POS production, không đưa secret vào evidence.
- [ ] Kiểm tra lỗi shipping headline và shard a11y 2 của CI 38852573993; phân biệt lỗi baseline với lỗi do thay đổi, nêu việc cần xử lý riêng.
- [ ] Không nới gate/test; lỗi required chưa giải quyết được ghi là blocker merge implementation, không trộn sửa CI không liên quan vào feature.
**Verification:** chạy setup trong plan, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`; đối chiếu jobs/logs CI và ghi rõ bước chưa chạy/lỗi. Không tự rerun vô hạn hoặc gọi lỗi là flaky chưa chứng minh.

**C0:** [x] Plan và spec bổ sung UX-01..UX-04/AC-25..AC-28 được duyệt; baseline và môi trường test đã được kiểm tra trước T01. Không đợi T13 mới sửa hợp đồng UX.

## T01 — Cấp dữ liệu quà độc lập với quote khả dụng

**Mục tiêu:** route có đủ dữ liệu để chọn/sửa quà từ cùng authority với quote, không phụ thuộc upsell.
**Phụ thuộc:** T00. **Scope:** M, 5 files. **AC:** 05, 16, 17, 21, 23.
**Files:** `src/commerce/benefit-checkout-render.ts`; `src/routes/checkout-model.ts`; `src/routes/checkout.ts`; `tests/domain/checkout-benefit-ui.test.ts`; `tests/domain/checkout-route-model.test.ts`.
**Nghiệm thu:**
- [ ] Tái dùng một giftState trong transaction đọc/render và resolver; DTO tối thiểu chứa picker/repair, không lộ nguyên state; gate OFF giữ legacy.
- [ ] Giữ định danh lựa chọn lỗi khi campaign biến mất, kể cả vào checkout lần đầu; lỗi resolver riêng vẫn chặn submit dù validation trước đó có thể ok.
- [ ] Phân biệt khả năng sửa quà với khả năng đặt hàng; không cấp proof giả cho trạng thái lỗi; khai báo props hiển thị/key UI dạng bổ sung để nối ở task sau.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/checkout-benefit-ui.test.ts tests/domain/checkout-route-model.test.ts`; `pnpm typecheck`. Kiểm tra không có hai phép tính entitlement cạnh tranh và không đổi giá/snapshot.

## T02 — Giữ owner dữ liệu nhận hàng ổn định

**Mục tiêu:** form hỗ trợ trạng thái tạm khóa khi thiếu quote mà không reset dữ liệu.
**Phụ thuộc:** T01. **Scope:** M, 4 files. **AC:** 03, 09, 11, 21.
**Files:** `src/components/commerce/guest-checkout-form.tsx`; `src/components/brand/guest-checkout-form.tsx`; `tests/domain/brand-checkout-adapter.test.ts`; `tests/a11y-runtime/checkout.spec.ts`.
**Nghiệm thu:**
- [ ] Form duy nhất nhận hợp đồng hiển thị/quà và trạng thái quote từ T01; thiếu proof khóa submit, không tạo form/luồng gửi thay thế.
- [ ] Tên, phone, province/commune, địa chỉ và note được giữ; không key theo digest/status, không persist PII vào storage hoặc DB.
- [ ] Validation trường, lựa chọn địa giới và luồng checkout legacy không hồi quy; việc giữ state qua route được nghiệm thu tiếp ở T03.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/brand-checkout-adapter.test.ts`; `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout.spec.ts --workers=1)`; `pnpm typecheck`.

## T03 — Sửa quà lỗi ngay tại checkout

**Mục tiêu:** hoàn tất lát cắt ready → sửa quà → ready qua route/page thực.
**Phụ thuộc:** T02. **Scope:** M, 5 files. **AC:** 09, 16, 21.
**Files:** `src/app/checkout/page.tsx`; `src/components/commerce/guest-checkout-form.tsx`; `src/components/brand/cart-gift-picker.tsx`; `tests/a11y-runtime/checkout-benefit.spec.ts`; `tests/domain/checkout-benefit-ui.test.ts`.
**Nghiệm thu:**
- [ ] Không thay form bằng link về cart khi gift repair; dùng dữ liệu T01 cho phép bỏ từng dòng lỗi dù thiếu proof/nhiều dòng lỗi/campaign cuối biến mất.
- [ ] Mutation bỏ vẫn giữ cart ownership; mọi lối đặt hàng khóa đến khi server trả lựa chọn và quote/proof hợp lệ; lỗi POS/lookup không được coi là sửa xong.
- [ ] Fill form cả note → làm gift hết hàng/hết hạn → refresh → bỏ tại chỗ → quote mới, dữ liệu nguyên vẹn; có thể để trống, không tự submit/restore quà.
**Verification:** `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout-benefit.spec.ts --workers=1)`; `pnpm typecheck`. Fixture phải đi qua route refresh, không chỉ mock lỗi trong picker.

**C1:** [ ] T01..T03 đạt; `pnpm lint`, `pnpm typecheck` và focused suites đạt; kiểm tra form retention + submit bị khóa khi chưa có proof bằng browser.

## T04 — Bổ sung ảnh và số liệu trình bày quà

**Mục tiêu:** dữ liệu đủ cho thẻ ảnh và lời nhắc đúng phần còn chọn được.
**Phụ thuộc:** T03. **Scope:** M, 3 files. **AC:** 04, 16, 17, 23.
**Files:** `src/commerce/cart-gift-selection.ts`; `src/routes/cart-gift-model.ts`; `tests/domain/cart-gift-model.test.ts`.
**Nghiệm thu:**
- [ ] Lấy ảnh từ nguồn sản phẩm trong truy vấn có sẵn, dùng media validation hiện có; ảnh thiếu/không tin cậy có fallback, không tự dựng URL hoặc thêm N+1.
- [ ] Số còn chọn được/phần chưa thể cấp theo validation chung; thiếu mẫu/stock chung dùng copy trung tính, không đổi snapshot hoặc dựng classifier mới.
- [ ] Fixture entitlement 2, một mẫu còn 10 chiếc, cấm trùng: trước chọn chỉ có thể nhận 1; sau chọn 1 còn 0 khả dụng, tiến độ 1/2, không báo hết hàng/đã đủ.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/cart-gift-model.test.ts tests/domain/product-media.test.ts`; `pnpm typecheck`.

## T05 — Điều phối mutation và đọc lại khi mất phản hồi

**Mục tiêu:** không đoán quà đã lưu khi response bị mất; không gửi thao tác phụ thuộc trên dữ liệu cũ.
**Phụ thuộc:** T03. **Scope:** M, 5 files. **AC:** 04, 11, 18, 22.
**Files:** `src/components/headless/use-cart-gifts.ts`; `src/commerce/cart-gift-selection-actions.ts`; `src/components/headless/cart-gift-mutation-model.ts` (mới); `tests/domain/cart-gift-mutation-model.test.ts` (mới); `tests/a11y-runtime/cart-gift-picker.spec.ts`.
**Nghiệm thu:**
- [ ] Phân biệt pending, từ chối không ghi đã xác định và kết quả chưa rõ; khóa đồng bộ thao tác xung đột, không tạo đường mutation thứ hai.
- [ ] Khi chưa rõ, gọi readback chỉ đọc dùng service/cookie hiện có và DTO đã lọc; chỉ mở thao tác phụ thuộc sau đọc lại/refresh quote tương ứng. Readback lỗi cho thử đọc lại, không blind retry ghi.
- [ ] Không giữ busy mãi sau kết quả đã xác định, không mở submit sớm trước khi quote cập nhật; tests đối chiếu lựa chọn thật sau mất response.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/cart-gift-mutation-model.test.ts`; `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts cart-gift-picker.spec.ts --workers=1)`; `pnpm typecheck`.

## T06 — Thẻ quà và thao tác bỏ/chọn lại

**Mục tiêu:** thay dropdown bằng giao diện chọn quà ngắn, phân biệt xem với đã lưu và giữ đúng hợp đồng bỏ trước chọn lại.
**Phụ thuộc:** T04, T05. **Scope:** M, 4 files. **AC:** 01, 04, 16, 17, 22, 23, 25, 27, 28. **UX:** 01, 03, 04.
**Files:** `src/components/brand/cart-gift-picker.tsx`; `src/components/brand/gift-product-card.tsx` (mới, component trình bày nhỏ); `tests/a11y-runtime/cart-gift-picker.spec.ts`; `tests/domain/cart-gift-model.test.ts`.
**Nghiệm thu:**
- [ ] Một tiến độ, thẻ ảnh/tên, chỉ một mẫu mở phiên bản, không list lại hàng mua/đoán màu-size. Chip chỉ xem và có nhãn chưa thêm; “Nhận quà này” mới ghi. Pending không tăng count; lưu/readback thành công mới đổi tổng kết và thông báo thành công nhìn thấy/được screen reader nhận biết, không cướp focus. Chưa rõ kết quả không báo thành công sớm (UX-01, UI-04/UI-05).
- [ ] Đủ suất vẫn xem mẫu/size khác, chỉ nhận thêm bị khóa. “Xem” mở quản lý; cảnh báo bỏ trước nhìn thấy cạnh hành động trong phần mở rộng trước khi bấm. Hủy trước bỏ giữ cũ; bỏ thành công có thông báo món/số lượng; hủy/nhận mới bị từ chối sau bỏ nói rõ suất thực tế còn trống, không tự khôi phục. Phân biệt giảm một/bỏ toàn bộ; readback khi chưa rõ (UX-03, AC-22/27).
- [ ] Chủ động thu gọn chỉ count/trạng thái ngắn + mở quản lý; không lặp từng món/nút bỏ, không che chưa thêm/pending/lỗi. Mở có nội dung/thao tác hữu ích. Không tự đóng/cuộn sau món cuối; đúng hết quyền/thiếu mẫu/quà lỗi, label/focus/keyboard và token brand; không API swap hoặc rollback tự động (UX-04, UI-06).
**Verification:** `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts cart-gift-picker.spec.ts --workers=1)`; `pnpm test:domain`. Đối chiếu persisted selection theo AC-22/25/27 và phần mở/thu gọn AC-28; kiểm tra status/keyboard/screen reader, không chỉ screenshot/axe. Hành trình sau popup của AC-25 được nối T08/T10 và nghiệm thu T12.

**C2:** [ ] T04..T06 đạt; `pnpm lint`, `pnpm typecheck`, focused suites đạt. Xem browser sớm cho ba trạng thái thẻ, count/status theo lưu thật (UX-01), duyệt đủ suất/cảnh báo trước bỏ/kết quả cụ thể (UX-03), mở/thu gọn hữu ích và không tự đóng món cuối (UX-04), ảnh/copy/readback. Ghi screen reader thực tế hoặc phần còn pending; không nhận C2 là bằng chứng đường popup chưa triển khai.

## T07 — Đặt khu vực quà dưới hàng mua trên cart

**Mục tiêu:** một gift area trong cột nội dung, aside chỉ giữ tổng kết.
**Phụ thuộc:** T06. **Scope:** S, 2 files. **AC:** 01, 02, 03.
**Files:** `src/app/cart/page.tsx`; `tests/a11y-runtime/cart-gift-picker.spec.ts`.
**Nghiệm thu:**
- [ ] Picker ngay sau danh sách hàng mua; lời nhắc và nội dung mở rộng cùng khu vực, không tạo thêm bản sao trong aside.
- [ ] Không thay paid segments, controls hàng mua, totals/discount/ship hoặc xử lý empty/stale cart ngoài phạm vi.
- [ ] Anchor/focus tới đúng picker và chỉ một ID; mobile/desktop không lặp danh sách hàng mua trong khu vực quà.
**Verification:** `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts cart-gift-picker.spec.ts --workers=1)`; `pnpm typecheck`.

## T08 — Khu vực checkout độc lập upsell

**Mục tiêu:** chọn mọi quyền nhận tại checkout và có đường quay lại vùng thanh toán, không phải mua thêm hoặc về cart.
**Phụ thuộc:** T03, T07. **Scope:** M, 5 files. **AC:** 02, 03, 05, 09, 11, 21, 25, 26, 28. **UX:** 01, 02, 04.
**Files:** `src/app/checkout/page.tsx`; `src/components/commerce/guest-checkout-form.tsx`; `src/components/commerce/checkout-upsell.tsx`; `tests/a11y-runtime/checkout-benefit.spec.ts`; `tests/a11y-runtime/promotion-upsell.spec.ts`.
**Nghiệm thu:**
- [ ] Form/page nhận picker trực tiếp; gỡ instance/lọc `attempt.giftIds` trong upsell nhưng giữ offers và hành vi thêm hàng. Mobile summary thu gọn vẫn thấy điểm chọn quà; desktop order list → gift area → totals; một controller, không nested form/duplicate ID. Quà trong order list giữ nguyên, khối quà thu gọn/mở phân vai đúng UX-04.
- [ ] Picker mở có thao tác phụ quay lại thanh toán (UX-02): điều hướng trong trang và focus tới điểm ổn định có tên trong vùng tổng kết, không focus submit, không save/claim/order/tự thu gọn/reset đã nhắc. Đủ/một phần/chưa nhận đều được quay lại; pending/uncertain không khóa điều hướng nhưng mọi lối đặt hàng còn khóa, response muộn không cướp focus.
- [ ] Phiên bản mới chỉ đang xem còn notice không chặn “chưa thêm” tại vùng thanh toán và khi thu gọn, không bị hiểu là đã lưu (UX-01). Dùng owner checkout hiện có/props nhỏ, không controller/store/persistence mới. Pending/refresh phối hợp form, nhận hàng/note nguyên vẹn; cutover cuối phối hợp T10, không phát hành nhắc mới với checkbox cũ.
**Verification:** `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout-benefit.spec.ts promotion-upsell.spec.ts --workers=1)`; `pnpm typecheck`. Kiểm tra đi–về trực tiếp, focus/notice/count và không tạo đơn; đường bắt đầu từ popup được nối tại T10.

## T09 — Vòng đời nhắc theo lượt checkout

**Mục tiêu:** nhắc một lần trong đúng phạm vi R-01, độc lập xác nhận quote.
**Phụ thuộc:** T01, T08. **Scope:** M, 5 files. **AC:** 12, 13.
**Files:** `src/components/headless/checkout-gift-reminder-model.ts` (mới); `src/components/headless/use-checkout-gift-reminder.ts` (mới); `src/commerce/checkout-attempt-key.ts` (mới); `src/routes/checkout.ts`; `tests/domain/checkout-gift-reminder-model.test.ts` (mới).
**Nghiệm thu:**
- [ ] Model unseen/open/seen không lẫn pending/consent; opaque key UI ổn định qua digest/paid revision, đổi giỏ thì khác; không chứa bearer hoặc cấp quyền server.
- [ ] Storage chỉ giữ UI metadata hợp lệ; reload cùng lượt phục hồi, storage hỏng/chặn fallback memory, không lưu form/proof/ack.
- [ ] Có contract dọn lượt khi rời checkout/thành công/đổi giỏ, không reset do render/StrictMode/refresh/retry; browser lifetime được kiểm chứng ở T12.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/checkout-gift-reminder-model.test.ts`; `pnpm typecheck`. Test key/data bounds và state transitions, không coi unit test là bằng chứng navigation thực.

**C3:** [ ] T07..T09 đạt; focused suites + `pnpm lint`, `pnpm typecheck`; một picker và quyền nhận không bị upsell che. Đường quay lại thanh toán trực tiếp có focus/notice đúng; chưa gỡ checkbox trước T10 hoặc coi đường popup đã được nghiệm thu.

## T10 — Popup và cutover luồng submit

**Mục tiêu:** first click chỉ nhắc, second intent gửi một lần qua pipeline hiện có; nối hành trình popup → chọn quà → quay lại.
**Phụ thuộc:** T05, T08, T09. **Scope:** M, 5 files. **AC:** 06, 07, 08, 10, 11, 12, 13, 14, 18, 19, 25, 26. **UX:** 01, 02.
**Files:** `src/components/commerce/guest-checkout-form.tsx`; `src/components/brand/checkout-gift-reminder-dialog.tsx` (mới); `src/commerce/guest-checkout-public-actions.ts`; `tests/domain/guest-checkout-public-actions.test.ts`; `tests/a11y-runtime/checkout-benefit.spec.ts`.
**Nghiệm thu:**
- [ ] Valid first submit còn suất chỉ mở modal, không order/reserve/POS/purchase; fields sai xử lý trước, no-entitlement/full/tier-only không popup.
- [ ] “Vẫn đặt hàng” hoặc form submit chủ động sau đóng đi cùng guard/action, claim yes chỉ cho quote hiện tại; X/Escape/chọn quà không gửi. Chọn quà mở/focus picker T08, quay lại không submit/reset nhắc. Chỉ bấm chip vẫn thấy chưa thêm tại thanh toán; lần submit chủ động tiếp theo chỉ dùng quà đã lưu, không tự lưu hoặc thêm popup thứ ba (UX-01/02). Gỡ checkbox/ackMissing cùng lần nối guard mới, giữ tier notice/totals.
- [ ] Focus/inert/accessible names đúng; chống double click/Enter nền; quote đổi hiện mới và chờ press mới, không nhắc lặp/replay ack/autosubmit; full form giữ nguyên cả hành trình nhận đủ/nhận một phần/quay lại. Pending/uncertain giữ khóa submit dù đã quay về vùng thanh toán.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/guest-checkout-public-actions.test.ts`; `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout-benefit.spec.ts --workers=1)`; `pnpm typecheck`. Đếm request tạo đơn và persisted order; chạy hành trình AC-25/26 từ popup tới lần gửi chủ động, không chỉ đếm event mở popup.

## T11 — Giữ hợp đồng server và snapshot

**Mục tiêu:** chứng minh UI mới không làm yếu kiểm tra quote/ack/stock/đơn trùng.
**Phụ thuộc:** T10. **Scope:** M, 5 files. **AC:** 14, 15, 16, 17, 18.
**Files:** `src/commerce/guest-checkout-submit-runtime.ts`; `tests/domain/guest-checkout-submit-runtime.test.ts`; `tests/domain/guest-checkout-public-actions.test.ts`; `tests/domain/checkout-quote-proof.test.ts`; `tests/database/benefit-checkout-snapshot.test.ts`.
**Nghiệm thu:**
- [ ] Cập nhật mô tả “tick” sang ý định sau nhắc; strict literal parser, cookie ownership, quote verification trước signed acknowledgement giữ nguyên, không default true.
- [ ] Missing/tampered/cross-cart/stale proof bị từ chối; quote mới cần press mới. Snapshot số đã nhận/chưa nhận/không thể cấp không bị trộn nguyên nhân.
- [ ] Chống đơn trùng/reservation và reconciliation giữ nguyên; có đường integration first reminder → explicit second submit → server verify → ack → order, không thay engine bằng mock.
**Verification:** `node --env-file-if-exists=.env.test.local --experimental-strip-types --test tests/domain/guest-checkout-submit-runtime.test.ts tests/domain/guest-checkout-public-actions.test.ts tests/domain/checkout-quote-proof.test.ts`; `node --env-file-if-exists=.env.test.local --experimental-strip-types --test --test-concurrency=1 tests/database/benefit-checkout-snapshot.test.ts`; `pnpm typecheck`.

## T12 — Hội tụ kiểm thử browser và bố cục

**Mục tiêu:** bổ sung khoảng trống của các tests đã viết ở từng slice và thu evidence runtime, không viết lại toàn bộ test suite.
**Phụ thuộc:** T06, T08, T10, T11. **Scope:** M, 5 files. **AC:** 09, 11, 12, 13, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28. **UX:** 01..04.
**Files:** `tests/a11y-runtime/checkout-benefit.spec.ts`; `tests/a11y-runtime/cart-gift-picker.spec.ts`; `tests/a11y-runtime/promotion-upsell.spec.ts`; `tests/a11y-runtime/pancake-fetch-fixture.cjs`; `docs/verification/storefront-gift-picker-checkout-reminder.md`.
**Nghiệm thu:**
- [ ] Điền form cả note → submit → popup → picker → nhận đủ hoặc một phần → quote mới → quay lại: dữ liệu/focus đúng, chưa order/reservation/POS/purchase; submit chủ động tiếp theo chỉ một lần, không nhắc lại (AC-26). Chạy thêm nhánh chỉ bấm size M rồi quay lại: notice chưa thêm, count không tăng, không lưu M khi đặt hàng; nhánh bấm nhận có pending rồi status/count sau xác nhận (AC-25). Không thay bằng test modal và picker tách rời.
- [ ] Replay quà lỗi qua route refresh, remove/reselect/mất response, nhiều campaign/stock chung, order sandbox; đối chiếu dữ liệu thật, thông báo trước/sau bỏ và suất trống (AC-27), không POS production. Reload/navigation/StrictMode, storage hỏng, upsell đổi revision, retry/hai lối submit đúng lifetime. Quay lại lúc pending/uncertain không mở submit; response muộn không cướp focus, console/network không lỗi mới.
- [ ] Ảnh 390/1440px cho năm trạng thái UI-06 và cả đủ-quà mở/thu gọn (AC-28): count ngắn khi thu gọn, mở quản lý hữu ích, không mất dòng quà của đơn hoặc tự đóng món cuối. Widths 320/375/768/1024, zoom chữ 200%, keyboard/mobile CTA đạt AC-19/20; kiểm tra screen reader cho status/focus, không suy pass từ axe/ảnh preview.
**Verification:** `(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout.spec.ts checkout-benefit.spec.ts cart-gift-picker.spec.ts promotion-upsell.spec.ts --workers=1)`. Ghi test names, output, screenshots và kết quả screen reader/manual/device thực tế; thiếu công cụ hoặc người kiểm tra thì ghi pending, không nhận viewport giả lập là thiết bị thật. Evidence phải chỉ rõ AC-25/26 cho nhận đủ, một phần, chỉ chip và pending; AC-27/28 kế thừa kiểm tra sớm C2 nhưng vẫn đối chiếu checkout.

**C4:** [ ] T10..T12 đạt; full commands mục 5 plan đạt, ma trận dưới có evidence cho đủ AC-01..AC-28 và UX-01..UX-04; lỗi CI required đã được xử lý trước merge chức năng.

## T13 — Tài liệu, review cuối và bàn giao

**Mục tiêu:** cập nhật sự thật sau implementation và chuẩn bị rollback, chưa deploy; không phải nơi mới quyết định UX.
**Phụ thuộc:** T12. **Scope:** M, 4 files. **AC:** gate tổng 01..28.
**Files:** `docs/specs/storefront-gift-picker-checkout-reminder.md`; `docs/specs/gift-quantity-promotions-v1.md`; `docs/verification/storefront-gift-picker-checkout-reminder.md`; `tasks/storefront-gift-picker-checkout-reminder-todo.md`.
**Nghiệm thu:**
- [ ] Spec/checklist FR-06/FR-11/GQ19 dẫn đúng hành vi mới, giữ lịch sử; task chỉ checked khi evidence đạt, không ghi “đã ship” trước release. UX-01..UX-04 phải đã được duyệt trong spec trước code; mọi thay đổi hợp đồng phát sinh quay lại review trước triển khai, không hợp thức hóa ở T13.
- [ ] Review correctness → security → architecture → simplicity: không secret/PII trong diff/log/storage, không dependency/schema/CI ngoài phạm vi, không Critical/Required còn mở.
- [ ] Ghi commit tốt để rollback, trigger mất form/nhắc lặp/đơn trùng/quote sai và cách xác minh sau rollback; runtime signals hiện có, không xóa/sửa order ledger. Owner duyệt release riêng.
**Verification:** `git diff --check`; kiểm tra diff và liên kết docs, full commands mục 5 plan + CI của đúng HEAD; kiểm tra lại AC evidence, ghi rõ bất kỳ bước chưa chạy. Không bypass required failures bằng việc merge spec đã xong.

**C5:** [ ] DoD implementation và review đạt; chưa deploy cho tới khi được yêu cầu/phê duyệt riêng.

## Ma trận truy vết AC → task chịu trách nhiệm

Mỗi AC phải có test hoặc quan sát runtime được ghi vào evidence khi triển khai; T13 là gate tổng, không thay test ở các task trước. AC-25..AC-28 là nghiệm thu UX mới, không coi coverage đủ 24 AC cũ là đã bao phủ chúng.

| AC | Task chính | Bằng chứng cần có |
|---|---|---|
| 01 | T06, T07 | Không paid list lặp; paid segments còn nguyên. |
| 02 | T07, T08, T10 | Vị trí cart/checkout, collapsed summary và không checkbox. |
| 03 | T02, T07, T08, T10 | Form/totals/discount/ship/tier notice không mất. |
| 04 | T04, T05, T06 | Ảnh/fallback và persisted receive/remove/decrement. |
| 05 | T01, T08 | Quà sẵn có khi upsell OFF/dismiss và nhiều campaign. |
| 06 | T10 | First click: modal có, order/POS/reservation/purchase không có. |
| 07 | T10, T11 | Popup continue gửi một lần qua action/proof chuẩn. |
| 08 | T10 | Close/X/Escape không order; press sau không popup. |
| 09 | T02, T03, T08, T12 | Các trường và note giữ qua chọn/bỏ/route refresh. |
| 10 | T10 | Field errors trước; no-right/full/tier-only không popup. |
| 11 | T02, T05, T08, T10, T12 | Pending/uncertain/refresh không gửi dữ liệu cũ. |
| 12 | T09, T10, T12 | Cùng lượt không nhắc lại; lượt/giỏ mới không kế thừa. |
| 13 | T09, T12 | Reload restore UI metadata, storage blocked/corrupt fallback. |
| 14 | T10, T11 | Proof tamper/cross-cart/stale và fresh re-submit sau quote đổi. |
| 15 | T11, T12 | Đường browser → action → verification → ack → snapshot/order. |
| 16 | T01, T03, T04, T06, T11 | Sửa lỗi tại chỗ, submit gate và audit/copy đúng nguyên nhân. |
| 17 | T01, T04, T06, T11 | Entitlement/duplicate/product/shared stock/paid demand. |
| 18 | T05, T10, T11, T12 | Double click/Enter/uncertain POS không duplicate/blind retry. |
| 19 | T10, T12 | Modal keyboard/focus/inert/names và close không submit. |
| 20 | T12 | Widths, text zoom, keyboard và CTA visibility. |
| 21 | T01, T02, T03, T08, T12 | Invalid gifts làm route đổi, form vẫn còn, sửa được cả initial invalid. |
| 22 | T05, T06, T12 | Hủy, failed remove/add, lost response, multi-quantity và lựa chọn lưu thật. |
| 23 | T01, T04, T06, T12 | 2 suất/1 mẫu/stock 10/no duplicates; neutral copy; stock chung. |
| 24 | T12 | Ảnh mobile/desktop năm trạng thái, một picker và hierarchy UI-06. |
| 25 | T06, T08, T10, T12 | UX-01: chưa thêm/pending/đã thêm, count/status theo lưu thật; popup → chỉ chip → quay lại thấy notice → submit không tự lưu/nhắc lại. C2 thẻ trước, T12 hành trình đầy đủ. |
| 26 | T08, T10, T12 | UX-02: nhận đủ/một phần → quay lại, focus/form nguyên, không order trước submit chủ động; pending/uncertain còn khóa và response muộn không cướp focus. |
| 27 | T06, T12 | UX-03: đủ suất vẫn duyệt, cảnh báo trước bỏ, thông báo sau bỏ/nhận mới thất bại đúng suất trống; readback, không swap/restore. C2 trước, T12 hồi quy checkout. |
| 28 | T06, T08, T12 | UX-04: count thu gọn, mở quản lý hữu ích, không tự đóng món cuối hoặc xóa dòng quà trong đơn; ảnh mở/thu gọn 390/1440px. |


## Theo dõi implementation PR #175

Owner yêu cầu triển khai end to end và mở PR mới ngày 16/10/2026. [Evidence hiện hành](../docs/verification/storefront-gift-picker-checkout-reminder.md) ghi lệnh, CI, AC và giới hạn kiểm tra. Các ghi chú chờ duyệt và CI lỗi ở phần lịch sử không thay thế trạng thái hiện hành này. Không coi merge plan là release chức năng.
