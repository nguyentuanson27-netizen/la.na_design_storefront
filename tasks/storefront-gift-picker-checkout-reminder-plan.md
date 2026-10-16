# Plan — Chọn quà tại chỗ và nhắc một lần trước đặt hàng

**Trạng thái:** PLAN CHỜ DUYỆT — chưa triển khai chức năng.  
**Ngày:** 16/10/2026.  
**Spec:** [storefront-gift-picker-checkout-reminder.md](../docs/specs/storefront-gift-picker-checkout-reminder.md), UI-01..UI-06, FLOW-01..FLOW-03, DATA-01..DATA-04, AC-01..AC-24.  
**Quyết định đầu vào:** chủ dự án yêu cầu merge PR #173 và lập plan ở PR mới. PR #173 đã merge tại `6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646`, chứa bản spec sửa `437904b`. Đây là checkpoint duyệt spec, không phải duyệt implementation hoặc release.  
**Baseline của plan:** `main@6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646`.  
**Task list:** [storefront-gift-picker-checkout-reminder-todo.md](storefront-gift-picker-checkout-reminder-todo.md).

## 1. Kết quả cần đạt và giới hạn

Khách chọn quà bằng ảnh ngay dưới danh sách hàng mua, không thấy lại danh sách sản phẩm đang mua trong picker. Checkout bỏ khối checkbox sau ghi chú. Khi còn suất chưa nhận, lần đặt hàng hợp lệ đầu tiên chỉ mở popup; hành động đặt hàng chủ động tiếp theo mới gửi đơn và không nhắc lại trong cùng lượt. Quà đã chọn mất hiệu lực sửa được tại checkout mà không mất dữ liệu nhận hàng.

Giữ các quyết định của spec: bỏ rồi chọn lại, không đổi nguyên tử; có thể đặt đơn không nhận đủ quà sau lời nhắc; form thiếu/sai thông tin được xử lý trước popup; không tự gửi đơn khi đóng popup hoặc sau refresh. Giá, tồn kho, giới hạn quà và quote proof vẫn do server xác thực.

PR plan này chỉ thêm hai tài liệu workstream và liên kết trong `tasks/README.md`. Không thay `src/`, tests, schema, dependency, CI hoặc dữ liệu; không ghi đè kế hoạch/checklist tổng ở `tasks/plan.md` và `tasks/todo.md`.

Không xây mới engine khuyến mại, API swap, global store, DB draft, hệ thống telemetry hoặc bộ mockup riêng. Không lưu tên/điện thoại/địa chỉ/ghi chú vào browser storage. Không đổi chính sách giá, ship, POS hay nới auth/rate limit. Mọi nhu cầu vượt các ranh giới này phải quay lại review.

Ảnh preview trong trao đổi chỉ là tham khảo thị giác. Spec đã merge là hợp đồng: một khu vực quà, nhãn “Xem quà đã chọn”/“Bỏ quà để chọn lại”, bố cục UI-06; không lấy giá, sản phẩm giả hoặc các khung lặp trong ảnh làm yêu cầu triển khai.

## 2. Hiện trạng và bằng chứng đầu vào

| Nguồn tại baseline | Ý nghĩa đối với kế hoạch |
|---|---|
| `src/commerce/benefit-checkout-quote.ts` | Resolver đã nhận `giftState` tùy chọn. Có thể tái dùng cùng một lần đọc để tạo quote và dữ liệu picker, không cần engine thứ hai. Ngoài validation, resolver còn có trường hợp quà lỗi do mapping biến thể hoặc xung đột READY/PREORDER. |
| `src/commerce/benefit-checkout-render.ts`, `src/routes/checkout.ts` | Nhánh lỗi quà hiện chỉ trả unavailable; `withUpsell()` chỉ chạy khi ready. Dữ liệu sửa quà phải độc lập với upsell và với sự tồn tại của proof. |
| `src/routes/checkout-model.ts`, `src/app/checkout/page.tsx` | `unquotable` hiện không có form/benefit/proof. Chỉ đổi một boolean trong picker không giữ được dữ liệu form khi route refresh. |
| `src/components/commerce/guest-checkout-form.tsx`, adapter brand | Chỉ một luồng checkout; state nhận hàng cục bộ, textarea ghi chú chưa controlled. Giữ owner ổn định, không fork một form thứ hai. |
| `src/commerce/cart-gift-selection.ts`, hook/action quà | `quantity: 0` bỏ chủ động kể cả campaign stale; thêm/giảm khác 0 kiểm tra toàn bộ lựa chọn. Không có swap; giữ hai thao tác độc lập và đọc lại khi kết quả ghi chưa rõ. |
| `src/routes/cart-gift-model.ts`, `tests/domain/cart-gift-model.test.ts` | Chưa có ảnh. Fixture `GQ14-F2` đã phân biệt thiếu mẫu hợp lệ với hết tồn; không suy nguyên nhân từ tên `shortForStock`. |
| `tests/a11y-runtime/playwright.config.ts` | Đã có checkout, checkout-benefit, cart-gift-picker, promotion-upsell specs; workers=1. Dùng lại hạ tầng này, không dựng test runner mới. |

### CI baseline phải được xử lý minh bạch

[CI run 38852573993 của PR #173](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/actions/runs/38852573993) đã được đọc trước khi merge spec:

- Job `verify` thành công: lint, typecheck, domain/integration suite qua `pnpm test`, worker unit tests và build.
- `verify-runtime` thất bại ở **Shipping promotion runtime policy smoke**; database smoke, các HTTP smoke trước đó và build đã thành công. Log báo `Homepage promotion headline rendered an unexpected policy state`: assertion vẫn đòi headline freeship trên homepage, trong khi baseline vừa đổi masthead sang chiến dịch mua 3/tặng 1 và mua 5/giảm 10%.
- `admin-a11y-runtime (2)` thất bại; các shard 1/3/4 thành công. **Chưa xác định nguyên nhân shard 2**, không gọi là flaky nếu chưa có bằng chứng.

Đây không phải bộ CI xanh. Merge tài liệu theo yêu cầu owner không xóa các lỗi này. T00 phải phân loại lại trên baseline trước build; sửa CI/runtime không liên quan bằng thay đổi riêng được duyệt. Không bỏ test hoặc đổi assertion chỉ để xanh. Các gate bắt buộc còn lỗi chặn merge implementation; plan vẫn có thể được review độc lập.

## 3. Các quyết định triển khai

### 3.1. Dữ liệu và lỗi sửa được tại checkout

Mở rộng hợp đồng hiển thị theo hướng bổ sung: dữ liệu quà tối thiểu, lý do cần sửa, và khả năng submit phải tách biệt. Trạng thái sửa quà không có quote/proof hợp lệ vẫn được xem và bỏ lựa chọn đã lưu; nó không được coi là ready.

Ưu tiên đọc `CartGiftState` một lần trong transaction render, truyền chính state đó vào `resolveBenefitCheckoutQuote({ giftState })`, rồi chuyển thành DTO picker tại ranh giới route/model. Không serialize nguyên state/Prisma row ra client. Gate OFF phải giữ nhánh legacy và không thêm truy vấn quà không cần thiết. Không áp dụng xử lý sửa quà cho lỗi giá, POS hay lookup không xác định.

DTO phải giữ campaign/variant/revision của lựa chọn cũ và fallback nhãn khi campaign không còn hoạt động; không cần proof đặt hàng để bỏ đúng dòng. Không dùng dữ liệu cũ để tạo entitlement mới. Khi validation không có số liệu đáng tin, không tự suy tiến độ hoặc CTA. `validation.ok` cũng chưa đủ để kết luận submit được: trạng thái cuối từ resolver/proof vẫn phải đạt.

Số còn chọn được/phần chưa thể cấp lấy từ phép tính chung của engine hiện có, kể cả giới hạn mẫu và stock chia sẻ; không cộng các mức tối đa từng campaign rồi hứa nhận đồng thời tất cả. Không đổi cấu trúc snapshot hoặc ý nghĩa `skippedWhileAvailable`, `contendedForSharedStock`, `shortForStock` để sửa câu chữ.

### 3.2. Một form và một nơi quản lý dữ liệu

Giữ `GuestCheckoutForm` là implementation duy nhất, adapter brand tiếp tục chuyển props. Form/owner dữ liệu phải ở cùng vị trí và identity qua ready → sửa quà → ready; không dùng digest hoặc trạng thái quote làm key. Ghi chú phải được bảo toàn như các trường khác, không chỉ tên/địa chỉ.

Mọi đường gửi đơn dùng một guard cho submit đang chạy, mutation quà/upsell, refresh hoặc kết quả ghi chưa rõ, quote chưa hợp lệ và kết quả POS chưa chắc chắn. Cần khóa đồng bộ trước render pending để chặn hai event cùng lượt. Guard chỉ khóa thao tác xung đột; lỗi lựa chọn không được khóa luôn đường bỏ quà lỗi.

Khi người dùng bỏ dòng lỗi, gọi mutation hiện có → đọc/refresh tại chỗ → cập nhật quote/proof → cho tiếp tục khi hợp lệ. Có thể để trống; không buộc nhận món thay thế. Nếu đọc lại thất bại, giữ form và nút thử đọc lại, không tự retry thao tác ghi. Không hứa khôi phục PII sau full browser reload/rời checkout.

### 3.3. Một khu vực quà, độc lập gợi ý mua thêm

Cart chuyển picker khỏi aside xuống sau hàng mua. Checkout dùng cùng DTO/picker cho mọi quyền nhận, không lọc theo `attempt.giftIds` và không phụ thuộc bật/dismiss upsell. Gỡ instance picker trong `CheckoutUpsell` khi instance chung được nối vào; giữ offers và khóa phối hợp của upsell.

Mobile: vùng order summary có thể thu gọn → nhắc/picker luôn có điểm truy cập → các phần form còn lại. Desktop: giữ hai cột hiện có, order list → gift area → totals ở cột đơn hàng. Tái tổ chức slots/composition ở form/page, không clone hai controller cho hai breakpoint. Không nested form, không ID trùng. Static totals có thể giữ composition hiện có miễn không tạo thêm bộ điều khiển quà/submit.

Chỉ thẻ đang mở có chips/nút nhận nổi bật. “Xem quà đã chọn” không ghi dữ liệu. “Bỏ quà để chọn lại” có lời phụ về việc bỏ trước; chỉ nhận món mới sau khi bỏ thành công và trạng thái server cập nhật. Hủy trước bỏ giữ quà cũ; bỏ thành công rồi hủy/nhận mới thất bại để suất trống, không tự khôi phục.

### 3.4. Nhắc một lần không phải đồng ý vĩnh viễn

Tách `unseen/open/seen`, trạng thái request và ý định đồng ý quote. Khóa lượt bằng opaque cart key dành riêng cho UI, ổn định qua thay đổi giỏ trong cùng lượt; không dùng `benefit.digest` hoặc `upsell.paidCartKey`. Đề xuất helper server nhỏ dùng HMAC có domain riêng trên cart identity với secret hiện có; key không chứa UUID/bearer, không cấp quyền, không cần persistence/schema mới. Kiểm tra trước khi thêm helper để tránh trùng tiện ích hiện có.

Trong tab chỉ lưu version/key/cờ đã nhắc cần thiết, không PII/proof/ack. Phục hồi sau reload cùng lượt theo R-01; rời checkout, thành công hoặc đổi giỏ kết thúc lượt. Memory fallback khi storage hỏng/chặn; không reset do StrictMode, refresh hoặc upsell. Hành vi navigation/Activity phải kiểm tra bằng browser đúng phiên bản, không coi cleanup effect đơn lẻ là bằng chứng.

First submit hợp lệ khi còn quà chỉ mở dialog. Nút “Vẫn đặt hàng” hoặc lần bấm form chủ động sau khi đóng dialog đi qua cùng pipeline validation/submit, tạo `nonclaimAcknowledged=yes` cho quote đang hiển thị. Không dùng hidden input luôn yes; mở/đóng/dialog storage không phát sinh claim hoặc order. Quote mới cần hiện ra và được gửi lại chủ động; giữ cờ đã nhắc nhưng không replay acknowledgement cũ.

Dùng dialog semantic và cơ chế focus hiện có/native, không thêm library. Focus ban đầu không vào nút gửi đơn; Escape/X trả focus và không submit. Pending, Enter giữ phím và click nền không biến first click thành xác nhận thứ hai. Bỏ checkbox và guard `ackMissing` cũ chỉ trong cùng thay đổi đã nối đầy đủ guard/dialog/claim mới.

## 4. Thứ tự, lát cắt và checkpoint

```text
T00 baseline / môi trường test
  -> T01 dữ liệu checkout từ cùng authority
  -> T02 form có thể giữ dữ liệu khi bị khóa
  -> T03 sửa quà tại checkout                    [C1]
  -> (T04 ảnh + số liệu, T05 mutation/readback)
  -> T06 thẻ quà và bỏ/chọn lại                  [C2]
  -> T07 vị trí trên cart
  -> T08 khu vực checkout độc lập upsell
  -> T09 vòng đời nhắc theo lượt                 [C3]
  -> T10 popup + cutover submit
  -> T11 regression server/proof/snapshot
  -> T12 browser / responsive / đối chiếu AC     [C4]
  -> T13 tài liệu và gate bàn giao               [C5]
```

C0 trước T01: owner duyệt plan; môi trường/fixture an toàn và lỗi baseline được phân loại. C1 chứng minh route refresh khi quà lỗi không mất form, không mở submit khi thiếu proof. C2 chứng minh ảnh/copy đúng, bỏ/chọn lại và mất phản hồi có kết quả xác định. C3 chứng minh chỉ một picker, mọi entitlement truy cập được, lifetime không gắn sai với quote. C4 chứng minh hai lần bấm qua luồng thật cùng ma trận AC. C5 là review cuối trước merge implementation, không phải lệnh deploy.

T04 và T05 có thể làm song song sau khi chốt DTO; các task cùng sửa form/page/picker làm tuần tự để tránh xung đột. Browser fixture cùng database không chạy song song; dùng workers=1 như cấu hình hiện có.

Mỗi task là một commit/slice có tests, không bắt buộc một PR riêng. Các thay đổi hiển thị ở T08 và cutover T10 phải được bàn giao đồng bộ, tránh phát hành nhắc mới nhưng còn checkbox/guard cũ. Phần thêm hợp đồng chưa sử dụng có thể đi trước; không merge trạng thái trung gian làm checkout kẹt. Khi chia PR dùng [ADR 0005](../docs/decisions/0005-pr-scope-reviewability.md), không tách tests khỏi hành vi chỉ để giảm file count. Task dự kiến S/M, tối đa khoảng 5 file; nếu thực tế vượt đáng kể thì chia lại theo hành vi.

## 5. Kiểm chứng và lệnh thực tế

Theo dependency tại baseline: Node >=22.14.0, pnpm 11.4.0, Next 16.3.3, React 19.2.0, Prisma 7.9.1. Browser workspace đã pin Playwright 1.62.0 và axe 4.12.1. Không nâng phiên bản trong workstream này.

Chỉ dùng database test riêng; các fixture browser có thao tác tạo/xóa dữ liệu. Dùng Pancake fetch fixture trong `tests/a11y-runtime/pancake-fetch-fixture.cjs`, không gọi POS production. Không ghi credential thật vào tài liệu/evidence.

Cài và chuẩn bị theo CI hiện có, sau khi kiểm tra env đang trỏ đúng database test:

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:deploy
(cd tests/a11y-runtime && npm ci --ignore-scripts --no-audit --no-fund)
(cd tests/a11y-runtime && npx playwright install --with-deps chromium)
```

Mỗi task hành vi phải có RED trước GREEN; test chỉ chứa mock boolean không thay thế đường route/submit. Chạy focused commands trong todo; ở checkpoint chạy lint/typecheck và các suite liên quan. Gate cuối:

```sh
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm test:db
pnpm build
(cd tests/a11y-runtime && npx playwright test --config playwright.config.ts checkout.spec.ts checkout-benefit.spec.ts cart-gift-picker.spec.ts promotion-upsell.spec.ts --workers=1)
```

Root không có `test:e2e`. Ưu tiên mở rộng bốn browser specs đã được config liệt kê; nếu thêm file mới phải nối testMatch, không tạo test không bao giờ chạy. Dùng viewport trong test cho desktop 1440px vì project storefront mặc định đang 390px. Ảnh 390/1440 ở năm trạng thái là evidence của implementation, không thay bằng ảnh AI preview. Các chiều rộng khác, zoom chữ 200%, keyboard/focus, network và console theo AC-19/20.

Trước khi sửa API framework, đọc guide bundled của Next đúng phiên bản cùng tài liệu [React state preservation](https://react.dev/learn/preserving-and-resetting-state), [Next Forms](https://nextjs.org/docs/app/guides/forms) và [WAI-ARIA dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Plan không khẳng định đã thử API mới trên runtime Next 16.3.3.

## 6. Rủi ro và ranh giới bảo mật

| Rủi ro | Chốt kiểm soát / nơi kiểm chứng |
|---|---|
| Form unmount hoặc note mất khi quote lỗi | Owner ổn định, note được giữ; T02/T03, AC-21 qua route refresh thật. |
| Nhắc lặp hoặc bỏ qua xác nhận quote mới | UI lifetime riêng, claim chỉ từ submit chủ động, server proof giữ nguyên; T09..T12. |
| Spoofing/tampering qua cart key, count, giá, claim/proof | Cookie ownership và strict parser; opaque key chỉ UI; fresh/cross-cart/tampered proof tests ở T11. |
| Hai lần ghi/submit hoặc mất phản hồi | Guard đồng bộ, readback trước mutation phụ thuộc, idempotency/reconciliation hiện có; T05/T10/T12. |
| Hứa tồn kho không có / gọi thiếu mẫu là hết hàng | Cùng authority, count/copy trung tính, stock chung; T01/T04/T06, AC-23. |
| Lộ PII / secret qua storage, log, ảnh | Chỉ UI metadata trong storage; DTO tối thiểu, media allowlist, không log form/token; security review T13. |
| DoS do thêm truy vấn hoặc request lặp | Tái dùng giftState và bounds hiện có, busy guard, không polling mới/nới rate limit; không tối ưu suy đoán. |
| “Đã đọc popup” bị coi là bằng chứng không thể phủ nhận | Browser boolean không chứng minh việc đã đọc; chỉ ghi claim qua cơ chế acknowledgement hiện tại, không nâng mức bảo đảm audit. |

## 7. Hoàn thành và rollback

Plan được duyệt chưa đồng nghĩa T00..T13 đã hoàn thành. Mọi task trong todo còn mở. Khi implementation đạt AC-01..AC-24, tests/lint/typecheck/build và browser có evidence, review không còn Critical/Required, các lỗi CI bắt buộc đã được giải quyết, mới đủ điều kiện đề nghị merge chức năng.

T13 ghi commit/test results/ảnh và lỗi còn lại vào `docs/verification/storefront-gift-picker-checkout-reminder.md` (file dự kiến, chưa tạo trong PR plan). Cập nhật tham chiếu FR-06/FR-11/GQ19 còn nói checkbox sau khi cutover được kiểm chứng; giữ lịch sử và không đánh dấu feature đã ship chỉ vì spec merge.

Không deploy trong PR plan hoặc tự động sau khi duyệt plan. Trước release, owner chốt phiên bản triển khai và người theo dõi; dùng tín hiệu checkout/benefit hiện có. Rollback khi mất form, popup lặp/chặn submit, đơn trùng hoặc vi phạm quote/stock: dừng rollout và quay lại bản ứng dụng tốt gần nhất đã xác định, xác minh checkout cũ; không xóa giỏ/order/snapshot hoặc sửa sổ audit để rollback. Không có schema change nên không yêu cầu migration rollback; kết quả POS chưa rõ tiếp tục qua reconciliation hiện có, không gửi lại mù.

**Verification của tài liệu:** đã đối chiếu spec/source/CI và kiểm tra manifest thứ tự phụ thuộc, 14 task, coverage đủ 24 AC, nhóm checkpoint và phạm vi file. Đây là kiểm chứng kế hoạch, không phải chạy các test của chức năng. Môi trường phiên này không clone được repository do DNS; không có local build/lint/test/browser mới. Kết quả CI được ghi ở mục 2 là lần chạy đã tồn tại trên GitHub.
