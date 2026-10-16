# Plan — Chọn quà tại chỗ và nhắc một lần trước đặt hàng

**Trạng thái:** PLAN VÀ BỔ SUNG SPEC UX CHỜ DUYỆT — chưa triển khai chức năng.  
**Ngày:** 16/10/2026.  
**Spec:** [storefront-gift-picker-checkout-reminder.md](../docs/specs/storefront-gift-picker-checkout-reminder.md), UI-01..UI-06, FLOW-01..FLOW-03, DATA-01..DATA-04, AC-01..AC-28; AC-25..AC-28 bổ sung sau review `87b7cd5`.  
**Quyết định đầu vào:** chủ dự án yêu cầu merge PR #173 và lập plan ở PR mới. PR #173 đã merge tại `6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646`, chứa bản spec sửa `437904b`. Đây là checkpoint duyệt spec gốc, không phải duyệt bổ sung UX ở PR #174, implementation hoặc release.  
**Baseline của plan:** `main@6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646`.  
**Task list:** [storefront-gift-picker-checkout-reminder-todo.md](storefront-gift-picker-checkout-reminder-todo.md).

## 1. Kết quả cần đạt và giới hạn

Khách chọn quà bằng ảnh ngay dưới danh sách hàng mua, không thấy lại danh sách sản phẩm đang mua trong picker. Checkout bỏ khối checkbox sau ghi chú. Khi còn suất chưa nhận, lần đặt hàng hợp lệ đầu tiên chỉ mở popup; hành động đặt hàng chủ động tiếp theo mới gửi đơn và không nhắc lại trong cùng lượt. Quà đã chọn mất hiệu lực sửa được tại checkout mà không mất dữ liệu nhận hàng.

Giữ các quyết định của spec: bỏ rồi chọn lại, không đổi nguyên tử; có thể đặt đơn không nhận đủ quà sau lời nhắc; form thiếu/sai thông tin được xử lý trước popup; không tự gửi đơn khi đóng popup hoặc sau refresh. Giá, tồn kho, giới hạn quà và quote proof vẫn do server xác thực.

PR #174 gồm hai tài liệu workstream, liên kết trong `tasks/README.md` và cập nhật spec UX sau review. Không thay `src/`, tests, schema, dependency, CI hoặc dữ liệu; không ghi đè kế hoạch/checklist tổng ở `tasks/plan.md` và `tasks/todo.md`.

Không xây mới engine khuyến mại, API swap, global store, DB draft, hệ thống telemetry hoặc bộ mockup riêng. Không lưu tên/điện thoại/địa chỉ/ghi chú vào browser storage. Không đổi chính sách giá, ship, POS hay nới auth/rate limit. Mọi nhu cầu vượt các ranh giới này phải quay lại review.

Ảnh preview trong trao đổi chỉ là tham khảo thị giác. Spec gốc cùng bổ sung UX sau khi được duyệt là hợp đồng: một khu vực quà, phân biệt xem/nhận/bỏ, bố cục UI-06; không lấy giá, sản phẩm giả hoặc các khung lặp trong ảnh làm yêu cầu triển khai.

### Tiếp thu review UX

Review tại `87b7cd5` chỉ ra khoảng trống nghiệm thu, không kết luận UI mới đã lỗi hoặc coi việc chưa code là lỗi PR. Tiếp thu cả bốn mục ở cấp đặc tả/kế hoạch; không hoãn sang T13. UX-01/02 xử lý đoạn hành trình còn thiếu; UX-03/04 bổ sung khả năng hiểu và quản lý lựa chọn mà không mở rộng backend. Các câu/nút mới là ví dụ, không bắt buộc đúng từng chữ; hành vi, focus và kết quả kiểm thử là hợp đồng cần duyệt.

| Mã | Quyết định và lý do | Spec / nghiệm thu | Task và checkpoint |
|---|---|---|---|
| UX-01 | Tiếp thu: thấy rõ chưa thêm → đang thêm → đã thêm; chip không phải lựa chọn đã lưu. Khi quay lại thanh toán vẫn thấy thông báo không chặn nếu phiên bản mới chỉ đang xem. | UI-04/UI-05, AC-25 | T06, T08, T10, T12; C2 kiểm tra thẻ/status trước, C4 kiểm tra hành trình sau popup. |
| UX-02 | Tiếp thu: có đường quay lại vùng thanh toán bằng điều hướng và focus; không ghi quà, submit hoặc reset đã nhắc. Cho quay lại cả khi chưa nhận đủ. | FLOW-02, AC-26 | T08, T10, T12; C3 kiểm tra điều hướng trực tiếp, C4 kiểm tra trọn hành trình từ popup. |
| UX-03 | Tiếp thu: đủ suất vẫn duyệt được mẫu/size khác; cảnh báo trước bỏ trong phần quản lý, thông báo kết quả cụ thể sau bỏ/nhận mới thất bại. Giữ bỏ trước, không swap/restore. | UI-04, AC-27 bổ sung AC-22 | T06, T12; C2 kiểm tra sớm, C4 hồi quy mất phản hồi/checkout. |
| UX-04 | Tiếp thu: danh sách đơn để kiểm tra món nhận; khối quà thu gọn chỉ trạng thái ngắn và mở quản lý. Không tự thu gọn sau món cuối hoặc xóa dòng quà khỏi đơn. | UI-06, AC-28 bổ sung AC-24 | T06, T08, T12; C2 kiểm tra mở/thu gọn, C4 đối chiếu checkout 390/1440px. |

AC-01..AC-24 giữ nguyên, thêm AC-25..AC-28 và truy vết riêng; đủ 24 AC cũ không thay thế nghiệm thu UX follow-up. Spec liên quan được sửa cùng PR này **trước task triển khai**; C0 cần duyệt cả bổ sung spec và plan. Không thêm task thứ 15 hoặc yêu cầu một bộ mockup riêng.

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

Đây không phải bộ CI xanh. Merge tài liệu theo yêu cầu owner không xóa các lỗi này. T00 phải phân loại lại trên baseline trước build; sửa CI/runtime không liên quan bằng thay đổi riêng được duyệt. Không bỏ test hoặc đổi assertion chỉ để xanh. Các gate bắt buộc còn lỗi chặn merge implementation; plan vẫn có thể được review độc lập. Các kết quả trên là bằng chứng lịch sử của run đã nêu, không phải CI của bản sửa UX.

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

Chỉ thẻ đang mở có chips/nút nhận nổi bật. UX-01 tách phiên bản đang xem khỏi lựa chọn đã lưu: nhãn “Chưa thêm vào đơn” → pending không tăng count → xác nhận lưu/readback mới có “Đã thêm vào đơn” và tổng kết mới. Kết quả chưa rõ giữ cảnh báo/readback, không báo thành công sớm; quote chưa refresh xong vẫn chặn submit. Status nhìn thấy và được screen reader nhận biết, không cướp focus; dùng cơ chế live region phù hợp theo UI-05, không thông báo cả picker.

UX-03: “Xem quà đã chọn” mở quản lý và duyệt lựa chọn khác, không mutation. Đủ suất vẫn xem/chọn chip mẫu/size khác; chỉ nhận thêm bị khóa. Cảnh báo bỏ trước nằm cạnh nút bỏ trong phần mở rộng, trước khi thực hiện; không dàn nút dài/cảnh báo từng món ở trạng thái thu gọn. Chỉ nhận món mới sau khi bỏ thành công và trạng thái server cập nhật. Hủy trước bỏ giữ quà cũ; bỏ thành công rồi hủy/nhận mới thất bại để suất trống, không tự khôi phục. Báo món/số lượng đã bỏ; nếu nhận mới bị từ chối chắc chắn, báo món mới chưa thêm và số suất thực tế còn trống. Không đoán kết quả mất response hoặc hứa còn lựa chọn nếu engine không xác nhận.

UX-04 phân vai: danh sách đơn giữ dòng quà để kiểm tra món nhận; picker quản lý lựa chọn. Chủ động thu gọn/vào checkout với quà đủ hợp lệ chỉ thấy số quà đã thêm + nút mở; mở mới có ảnh/tên/phiên bản và thao tác quản lý. Không xóa dòng quà khỏi order list, không tự thu gọn/cuộn khi nhận món cuối, không gọi thiếu mẫu/quà lỗi là đủ. “Xem” phải mở nội dung/thao tác hữu ích, không chỉ lặp điều đang hiện.

### 3.4. Nhắc một lần không phải đồng ý vĩnh viễn

Tách `unseen/open/seen`, trạng thái request và ý định đồng ý quote. Khóa lượt bằng opaque cart key dành riêng cho UI, ổn định qua thay đổi giỏ trong cùng lượt; không dùng `benefit.digest` hoặc `upsell.paidCartKey`. Đề xuất helper server nhỏ dùng HMAC có domain riêng trên cart identity với secret hiện có; key không chứa UUID/bearer, không cấp quyền, không cần persistence/schema mới. Kiểm tra trước khi thêm helper để tránh trùng tiện ích hiện có.

Trong tab chỉ lưu version/key/cờ đã nhắc cần thiết, không PII/proof/ack. Phục hồi sau reload cùng lượt theo R-01; rời checkout, thành công hoặc đổi giỏ kết thúc lượt. Memory fallback khi storage hỏng/chặn; không reset do StrictMode, refresh hoặc upsell. Hành vi navigation/Activity phải kiểm tra bằng browser đúng phiên bản, không coi cleanup effect đơn lẻ là bằng chứng.

First submit hợp lệ khi còn quà chỉ mở dialog. Nút “Vẫn đặt hàng” hoặc lần bấm form chủ động sau khi đóng dialog đi qua cùng pipeline validation/submit, tạo `nonclaimAcknowledged=yes` cho quote đang hiển thị. Không dùng hidden input luôn yes; mở/đóng/dialog storage không phát sinh claim hoặc order. Quote mới cần hiện ra và được gửi lại chủ động; giữ cờ đã nhắc nhưng không replay acknowledgement cũ.

Dùng dialog semantic và cơ chế focus hiện có/native, không thêm library. Focus ban đầu không vào nút gửi đơn; Escape/X trả focus và không submit. Pending, Enter giữ phím và click nền không biến first click thành xác nhận thứ hai. Bỏ checkbox và guard `ackMissing` cũ chỉ trong cùng thay đổi đã nối đầy đủ guard/dialog/claim mới.

UX-02 nối trọn đường đi–về: “Chọn quà ngay” trong popup mở/focus picker; picker mở tại checkout có thao tác phụ “Quay lại thanh toán” hoặc tương đương. Hành động này chỉ điều hướng trong trang và focus tới tiêu đề/điểm ổn định có tên trong vùng tổng kết thanh toán, không focus nút submit; không save, claim, submit, tự thu gọn hoặc reset đã nhắc. Nhận đủ/nhận một phần/chưa nhận đều được quay lại. Pending/uncertain vẫn cho điều hướng nhưng không mở khóa đặt hàng; response/refresh tới muộn không cướp focus.

UX-01 khi quay lại: phiên bản mới chỉ đang xem phải có thông báo ngắn “chưa thêm” tại vùng thanh toán, kể cả picker bị thu gọn. Đây là thông báo không chặn, không bước xác nhận thứ ba. Lần submit chủ động tiếp theo chỉ dùng quà đã lưu và quote hiện hành, không tự nhận chip hoặc nhắc lại. T08 giữ thông tin UI này trong owner checkout hiện có/props nhỏ, không thêm controller, store hay persistence mới.

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

C0 trước T01: owner duyệt plan **và spec bổ sung UX-01..UX-04**; môi trường/fixture an toàn và lỗi baseline được phân loại. C1 chứng minh route refresh khi quà lỗi không mất form, không mở submit khi thiếu proof.

C2 kiểm tra browser sớm sau T06: ba trạng thái thẻ/status (phần picker của AC-25), đủ suất vẫn xem mẫu khác, cảnh báo trước bỏ/thông báo kết quả (AC-27), mở/thu gọn có nội dung hữu ích và không tự đóng món cuối (phần picker của AC-28). Kiểm tra persisted selections, ảnh/copy và readback; ghi kiểm tra screen reader đã làm/chưa làm, không suy pass từ axe. C2 chưa thể nghiệm thu đường từ popup chưa triển khai.

C3 chứng minh chỉ một picker, mọi entitlement truy cập được, lifetime không gắn sai với quote; thử đường picker → thanh toán trực tiếp và notice chưa thêm ở T08. C4 kiểm tra trọn hành trình popup → picker → thanh toán → submit chủ động, cả nhận đủ/nhận một phần/chỉ bấm chip và pending, theo AC-25/26 cùng toàn bộ ma trận AC-01..AC-28. C5 là review cuối trước merge implementation, không phải lệnh deploy.

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

AC-25/26 cần bài test hành trình đầy đủ trong `checkout-benefit.spec.ts`, giữ thật form/route/action và đối chiếu order/reservation/POS fixture; không thay bằng hai test modal và picker riêng. T06 viết test thẻ/quản lý trong `cart-gift-picker.spec.ts`; T08/T10 nối kiểm thử checkout, T12 hội tụ và thu evidence. Kiểm tra focus sau chuyển vùng và response muộn, nội dung chưa thêm trước submit, count sau xác nhận, cả ảnh mở/thu gọn. Screen reader thực tế phải được ghi tên công cụ/kết quả; thiếu công cụ/người kiểm tra thì để pending, không coi automated accessibility là đủ.

Trước khi sửa API framework, đọc guide bundled của Next đúng phiên bản cùng tài liệu [React state preservation](https://react.dev/learn/preserving-and-resetting-state), [Next Forms](https://nextjs.org/docs/app/guides/forms) và [WAI-ARIA dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Bản sửa UX đã đối chiếu WAI-ARIA dialog về focus theo bước tiếp theo và [W3C ARIA22](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA22) về status không chuyển focus; đó là hướng dẫn cách đáp ứng, không bắt buộc tên nút/bố cục. Plan không khẳng định đã thử API mới trên runtime Next 16.3.3.

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
| Nhầm chọn size là đã nhận, hoặc quay lại nhưng focus còn ở picker | Nhãn/status theo lưu thật, notice tại thanh toán, điều hướng không submit; T06/T08/T10/T12, AC-25/26. |
| Đủ suất khóa cả xem mẫu, quản lý lặp và cảnh báo sai thời điểm | Duyệt chỉ đọc, cảnh báo trong phần mở rộng, count thu gọn và hành động mở có ích; T06/T08/T12, AC-27/28. |

## 7. Hoàn thành và rollback

Plan được duyệt chưa đồng nghĩa T00..T13 đã hoàn thành. Mọi task trong todo còn mở. Khi implementation đạt AC-01..AC-28, tests/lint/typecheck/build và browser có evidence, review không còn Critical/Required, các lỗi CI bắt buộc đã được giải quyết, mới đủ điều kiện đề nghị merge chức năng.

T13 ghi commit/test results/ảnh và lỗi còn lại vào `docs/verification/storefront-gift-picker-checkout-reminder.md` (file dự kiến, chưa tạo trong PR plan). Cập nhật tham chiếu FR-06/FR-11/GQ19 còn nói checkbox sau khi cutover được kiểm chứng; giữ lịch sử và không đánh dấu feature đã ship chỉ vì spec merge. Quyết định UX phải đã nằm trong spec được duyệt trước implementation; T13 chỉ cập nhật kết quả, không hợp thức hóa UX tự quyết khi code.

Không deploy trong PR plan hoặc tự động sau khi duyệt plan. Trước release, owner chốt phiên bản triển khai và người theo dõi; dùng tín hiệu checkout/benefit hiện có. Rollback khi mất form, popup lặp/chặn submit, đơn trùng hoặc vi phạm quote/stock: dừng rollout và quay lại bản ứng dụng tốt gần nhất đã xác định, xác minh checkout cũ; không xóa giỏ/order/snapshot hoặc sửa sổ audit để rollback. Không có schema change nên không yêu cầu migration rollback; kết quả POS chưa rõ tiếp tục qua reconciliation hiện có, không gửi lại mù.

**Verification của tài liệu:** bản đầu đã đối chiếu spec/source/CI tại baseline nêu trên. Bản sửa UX đọc lại spec/plan/todo/README ở `87b7cd5`, đối chiếu review và hai nguồn W3C; chạy kiểm tra manifest được trích thủ công cho 14 task, DAG/phụ thuộc, coverage 28 AC và phân công UX/checkpoint. Đây là kiểm chứng cấu trúc kế hoạch, không phải kiểm thử chức năng hoặc parser toàn bộ Markdown. Rà soát bản sửa là tự review, chưa có reviewer độc lập cho revision mới. Container không tải được raw repository do DNS; không có local app build/lint/test/browser/screen reader mới. Kết quả CI mục 2 vẫn là run lịch sử, không phải kết quả của bản sửa UX.
