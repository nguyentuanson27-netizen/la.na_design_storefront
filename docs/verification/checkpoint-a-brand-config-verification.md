# Báo cáo Verification Checkpoint A — Brand Config & Static Truth

**Project:** La.na Design Storefront  
**Repository:** `https://github.com/nguyentuanson27-netizen/la.na_design_storefront`  
**Evaluated Branch:** `main`  
**Exact Commit SHA:** `4438cbab82ee2ba7c8a54368f6ce98bda55fcc9d`  
**Working Tree:** Clean (`nothing to commit, working tree clean`)  
**Package Manager:** `pnpm@11.4.0` (Node.js `v24.19.0`)  
**Verdict:** **FAIL / BLOCKED** (Không đóng Checkpoint A; không sửa code production)  
**Date:** 2026-09-17  

---

## 1. Tổng quan Checkpoint A Gate Table

Theo quy định của `tasks/todo.md` và `tasks/plan.md`, Checkpoint A chỉ được đóng khi 100% các tiêu chí dưới đây đạt yêu cầu.

| Tiêu chí | Kết quả | Chi tiết & Bằng chứng thực tế |
|---|---|---|
| **1. Review F3a + A1–A8** | **PASS** | **0 Critical / 0 Required findings**. Cấu hình thương hiệu La.na Design, pháp lý, phân tách vai trò liên hệ/pháp nhân, 3 size guides, chính sách COD/vận chuyển, và routing đã được rà soát đối chiếu trực tiếp với master spec. |
| **2. Active Nav Link Resolution** | **PASS** | Tất cả 14 active primary destinations + 9 active footer destinations resolve non-404. Tuyệt đối không có link trỏ `/lookbook` hoặc `/flash-sale`. |
| **3. Brand Leak / Current Truth Audit** | **PASS** | Quét toàn bộ `src/`: 0 rò rỉ tên "LA Clothing", menswear copy, thời gian giao hàng cũ (`3–15 ngày`), hoặc bank transfer khả dụng trên các bề mặt hiển thị công khai. |
| **4. `pnpm lint`** | **PASS** | Exit code `0` (0 errors, 13 warnings về unused vars đã ghi nhận từ trước). |
| **5. `pnpm typecheck`** | **PASS** | Exit code `0` (`tsc --noEmit` sạch, không có lỗi kiểu). |
| **6. `pnpm test:domain`** | **FAIL / BLOCKED** | Exit code `1` (1698/1709 tests pass). 1 test fail do path separator trên Windows (`route-boundary.test.ts`); 10 tests fail do thiếu env `DATABASE_URL` trong shell local. |
| **7. `pnpm test`** | **FAIL / BLOCKED** | Exit code `1` (Bao gồm domain failures trên + integration smoke tests yêu cầu kết nối Postgres database thật). |
| **8. `pnpm build`** | **FAIL / BLOCKED** | Exit code `1` khi chạy mặc định (do thiếu `BETTER_AUTH_SECRET` và `BETTER_AUTH_URL` trong `.env.local`). Khi cung cấp đủ env như CI, build thành công 37/37 static routes (exit code `0`). |

---

## 2. Rà soát Chi tiết Content & Code Review (F3a + A1–A8)

Đã rà soát chi tiết mã nguồn trên exact HEAD `4438cbab82ee2ba7c8a54368f6ce98bda55fcc9d`:

- **A1 (Owner facts & Policy authority sync)**:
  - `src/brand/policy.config.ts` và `docs/specs/la-na-design-policy-authority.md` đồng nhất với master spec và các quyết định phỏng vấn.
  - Không chứa các placeholder nháp (`TODO`, `TBD`, `XXX`, `example.com`) trên các bề mặt hiển thị công khai.
- **A2 / A3 (Legal vs Business contact roles & Brand identity)**:
  - Pháp nhân được khai báo riêng biệt tại `BRAND.legal`:
    - Tên công ty: `CÔNG TY TNHH QUỐC TẾ THƯƠNG MẠI LAS`
    - Mã số thuế: `0111242251` (Ngày cấp: `7/10/2025`)
    - Trụ sở đăng ký: `Số 06 Đường Manor 2str, Sunrise C, KĐT The Manor Central Park, Phường Định Công`
    - Email pháp nhân: `congtytnhh.las@gmail.com`
  - Thông tin hỗ trợ/đổi trả khách hàng tại `BRAND.contact`:
    - Địa chỉ kinh doanh: `212 Nguyễn Trãi, Đại Mỗ, Hà Nội`
    - Email hỗ trợ: `la.nadesignsince2022@gmail.com`
    - Hotline: `0923159666` (+84923159666)
    - Giờ hỗ trợ: `08:00 - 22:00` hàng ngày (UTC+7)
  - Người đại diện pháp luật: Hoàn toàn được giữ kín theo yêu cầu bảo vệ quyền riêng tư của chủ sở hữu.
  - Tên thương hiệu hiển thị mặc định: `La.na Design` (Search alias: `Lana Design`).
  - Google Merchant defaults: `female / adult` (loại bỏ hoàn toàn cấu hình menswear thừa kế từ template cũ).
- **A4 (Size Guides)**:
  - Có đúng 3 bảng size chuẩn theo §11 master spec:
    1. `ao-dai` (S, M, L): Thông số vòng ngực, eo, mông, chiều cao, cân nặng.
    2. `set-vay-form-rong` (S, M, L, XL): Đầy đủ ngực, eo, mông, chiều cao, cân nặng.
    3. `set-vay-form-nho` (S, M, L, XL): Không có dòng thông số Mông theo đúng dữ liệu gốc.
  - Đơn vị đo: cm (số đo cơ thể, chiều cao), kg (cân nặng).
  - Dung sai: `tolerance: null` (không áp dụng dung sai cố định `±3 cm` của Brand #1).
- **A5 (Fulfillment & Payment)**:
  - Vận chuyển: 4 đơn vị hợp tác (`GHN`, `GHTK`, `Viettel Post`, `J&T`).
  - Thời gian giao dự kiến: Hà Nội `1–3 ngày`, Tỉnh/thành khác `3–10 ngày`. Nêu rõ đây là thời gian dự kiến, không cam kết tuyệt đối, mặc định không cung cấp mã tracking theo dõi.
  - Thanh toán: Duy nhất COD (`Thanh toán khi nhận hàng (COD)`).
  - Chuyển khoản ngân hàng: Công bố rõ ràng `Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.`
  - Đổi trả: Cửa sổ 15 ngày kể từ ngày nhận hàng; 5 trường hợp chấp nhận đổi trả; phí đổi hàng theo nhu cầu khách hàng là 50.000 VNĐ.
- **F3a / A6 / A8 (Route & Navigation Cutover)**:
  - Các route danh mục cha và con (`/ao-dai/*`, `/set-do/*`, `/vay-dam`, `/phu-kien`) tồn tại.
  - `/sale` là route sản phẩm khuyến mãi duy nhất công khai.
  - `/lookbook` và `/flash-sale` đã bị gỡ bỏ hoàn toàn khỏi active navigation, sitemap và manifest.
  - `/shop` vẫn là public route nhưng nằm trong footer, không nằm ở primary nav.
- **A7a / A7b (Policy & Static Destinations)**:
  - Toàn bộ 11 anchor chính sách trên hub `/policies` (`van-chuyen`, `thanh-toan`, `doi-tra-hoan-tien`, `lien-he`, `ho-tro-truc-tuyen`, `khieu-nai`, `dieu-khoan-chung`, `chinh-sach-gia`, `bao-mat`, `dieu-kien-cung-cap`, `quyen-nghia-vu`) và các trang `/shipping`, `/returns`, `/about`, `/contact`, `/size-guide` đều hoạt động.

---

## 3. Active Navigation & Route Resolution Evidence

Toàn bộ 23 active route links đều resolve thành công về các Next.js page modules trong `src/app/` và được sinh tĩnh trong build:

### Primary Navigation (14 hrefs):
1. `/ao-dai` (`src/app/ao-dai/page.tsx`)
2. `/ao-dai/cach-tan` (`src/app/ao-dai/cach-tan/page.tsx`)
3. `/ao-dai/tet` (`src/app/ao-dai/tet/page.tsx`)
4. `/ao-dai/cuoi` (`src/app/ao-dai/cuoi/page.tsx`)
5. `/ao-dai/4-ta` (`src/app/ao-dai/4-ta/page.tsx`)
6. `/ao-dai/6-ta` (`src/app/ao-dai/6-ta/page.tsx`)
7. `/set-do` (`src/app/set-do/page.tsx`)
8. `/set-do/set-vay` (`src/app/set-do/set-vay/page.tsx`)
9. `/set-do/set-quan-ao` (`src/app/set-do/set-quan-ao/page.tsx`)
10. `/vay-dam` (`src/app/vay-dam/page.tsx`)
11. `/phu-kien` (`src/app/phu-kien/page.tsx`)
12. `/new-arrivals` (`src/app/new-arrivals/page.tsx`)
13. `/collections` (`src/app/collections/page.tsx`)
14. `/sale` (`src/app/sale/page.tsx`)

### Footer Navigation (9 hrefs):
15. `/shop` (`src/app/shop/page.tsx`)
16. `/new-arrivals` (`src/app/new-arrivals/page.tsx`)
17. `/track-order` (`src/app/track-order/page.tsx`)
18. `/about` (`src/app/about/page.tsx`)
19. `/shipping` (`src/app/shipping/page.tsx`)
20. `/returns` (`src/app/returns/page.tsx`)
21. `/size-guide` (`src/app/size-guide/page.tsx`)
22. `/contact` (`src/app/contact/page.tsx`)
23. `/account` (`src/app/account/page.tsx`)

### Obsolete Routes:
- `/lookbook`: Không có trong primary/footer navigation, không có route file, `matchesStorefrontRoute("/lookbook")` = `false`.
- `/flash-sale`: Không có trong primary/footer navigation, không có route file, `matchesStorefrontRoute("/flash-sale")` = `false`.

---

## 4. Brand-Leak / Current-Truth Audit

Đã quét toàn bộ cây thư mục `src/`:
- `LA Clothing`: Tuyệt đối không xuất hiện trên các bề mặt hiển thị công khai hoặc runtime. 4 lần xuất hiện duy nhất là trong các comment JSDoc lịch sử giải thích lý do thay đổi từ Brand #1 sang Brand #2.
- `thời trang nam` / menswear: 0 kết quả trên public surfaces.
- Thời gian giao hàng cũ (`3–15 ngày` / `3-15`): 0 kết quả.
- Bank transfer khả dụng: 0 kết quả.
- `/lookbook`: 0 kết quả trong `src/`.
- `/flash-sale`: 0 kết quả trong `src/app/`, navigation hoặc sitemap (chỉ xuất hiện trong hàm mapping URL pagination cũ của `/sale`).
- Testsuite `tests/domain/brand-leak.test.ts` kiểm tra đệ quy mọi leaf string của `BRAND`, `SIZE_GUIDE`, `FULFILLMENT`, `brandHomeLabel`: **PASS 4/4 tests**.

---

## 5. Kết quả Thực thi 5 Lệnh Kiểm thử Bắt buộc

### 5.1. `pnpm lint`
```bash
$ eslint .
✖ 13 problems (0 errors, 13 warnings)
```
- **Exit Code**: `0`
- **Kết luận**: **PASS** (13 warnings về unused vars đã tồn tại từ trước, 0 error).

### 5.2. `pnpm typecheck`
```bash
$ tsc --noEmit
```
- **Exit Code**: `0`
- **Kết luận**: **PASS** (Hoàn toàn sạch lỗi type).

### 5.3. `pnpm test:domain`
```bash
$ node --experimental-strip-types --test tests/domain/*.test.ts
ℹ tests 1709
ℹ pass 1698
ℹ fail 11
```
- **Exit Code**: `1`
- **Kết luận**: **FAIL / BLOCKED**
- **Chi tiết các ca thất bại**:
  1. `tests/domain/route-boundary.test.ts:219:1`: Lỗi so sánh path separator trên Windows (`C:/...` vs `C:\\...`).
  2. 10 tests fail do thiếu biến môi trường `DATABASE_URL` trong shell local (`DATABASE_URL must be configured on the server`).

### 5.4. `pnpm test`
```bash
$ node --experimental-strip-types --test tests/domain/*.test.ts tests/integrations/*.test.ts
```
- **Exit Code**: `1`
- **Kết luận**: **FAIL / BLOCKED**
- **Chi tiết**: Bao gồm 11 lỗi domain test trên cùng các lỗi kết nối Postgres database của integration smoke tests (`tests/integrations/product-slug-http.test.ts`).

### 5.5. `pnpm build`
```bash
$ next build
▲ Next.js 16.2.11 (Turbopack)
- Environments: .env.local
Error [AuthConfigError]: BETTER_AUTH_SECRET must contain at least 32 characters
Error: Failed to collect page data for /admin/promotions
```
- **Exit Code**: `1`
- **Kết luận**: **FAIL / BLOCKED** khi chạy mặc định trên môi trường local do thiếu env `BETTER_AUTH_SECRET` (>= 32 chars) và `BETTER_AUTH_URL`.
- *(Lưu ý: Khi bổ sung biến môi trường như CI, Next.js build thành công 37/37 routes trong 772ms với exit code 0).*

---

## 6. Đối chiếu GitHub Actions CI trên exact HEAD

- **CI Run ID**: `35180907723` (Commit `4438cbab82ee2ba7c8a54368f6ce98bda55fcc9d`)
- **Trạng thái**:
  - `CI / verify`: **SUCCESS** (Ubuntu Linux 22.x với Docker Postgres 16 service container, 7m20s)
  - `CI / admin-a11y-runtime`: **SUCCESS**
  - `Merchant feed runtime`: **SUCCESS**
  - `Catalog indexation runtime`: **SUCCESS**
  - `VPS container verification`: **SUCCESS**
- **Nhận xét**: Trên môi trường Linux CI có sẵn service Postgres và các biến env mock đầy đủ, toàn bộ test và build đều vượt qua. Tuy nhiên, theo quy định của Checkpoint A, kết quả CI từ xa không thay thế được lệnh chạy thực tế trên môi trường đánh giá local.

---

## 7. Quyết định Đóng Checkpoint (Decision)

### **KẾT LUẬN: FAIL / BLOCKED**

Theo đúng quy định của Checkpoint A:
1. **KHÔNG đóng Checkpoint A** và **KHÔNG tích hoàn thành** các hàng mục Checkpoint A trong `tasks/todo.md`.
2. **KHÔNG tự ý sửa code production** trong lane verification này.
3. Báo cáo chi tiết nguyên nhân gốc rễ và đề xuất các task xử lý tiếp theo.

---

## 8. Chi tiết các Vấn đề Ngăn trở (Blockers & Root Cause Analysis)

### Blocker 1: Bug chuẩn hóa đường dẫn đa nền tảng (Cross-platform path separator bug)
- **Mức độ nghiêm trọng**: **Medium** (Lỗi portability cấp độ kiểm thử)
- **Vị trí**: `tests/domain/route-boundary.test.ts:223`
- **Tái hiện**:
  ```bash
  node --experimental-strip-types --test tests/domain/route-boundary.test.ts
  ```
- **Thông báo lỗi**:
  ```text
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'C:/Users/nguye/.../src/routes/manifest.ts'
  - 'C:\\Users\\nguye\\...\\src\\routes\\manifest.ts'
  ```
- **Nguyên nhân**: Hàm `resolveSpecifier` gọi `ts.resolveModuleName` của TypeScript compiler API, vốn luôn trả về đường dẫn dùng dấu gạch chéo xuôi (`/`). Trong khi đó, `path.join(REPO_ROOT, "src/routes/manifest.ts")` trên Windows trả về dấu gạch chéo ngược (`\`). Phép so sánh `assert.equal` so sánh chuỗi trực tiếp nên bị fail trên Windows (nhưng pass trên Linux).
- **Đề xuất xử lý**: Tạo một task bug-fix PR riêng để chuẩn hóa đường dẫn trước khi so sánh (`normalizePath(actual) === normalizePath(expected)` hoặc chuyển đổi qua `path.resolve`), tuân thủ quy trình Debugging → TDD → Review.

### Blocker 2: Thiếu biến môi trường local cho Domain Tests & Build
- **Mức độ nghiêm trọng**: **Medium** (Thiếu sót cấu hình môi trường phát triển local)
- **Vị trí**:
  - `src/db/prisma.ts:12` (`DATABASE_URL must be configured on the server`)
  - Static page collection của Next.js build tại `/admin/*` (`BETTER_AUTH_SECRET must contain at least 32 characters`, `BETTER_AUTH_URL must be configured`)
- **Tái hiện**:
  Chạy `pnpm test:domain` hoặc `pnpm build` mà không export biến môi trường.
- **Nguyên nhân**:
  10 domain tests import gián tiếp các module có dính `prisma.ts`, khiến `src/db/prisma.ts` ném ngoại lệ ngay khi import nếu không có `DATABASE_URL`. Next.js build đánh giá các route `/admin` phụ thuộc vào Better Auth, ném ngoại lệ nếu thiếu secret.
- **Đề xuất xử lý**:
  - Cập nhật `.env.local` hoặc bổ sung cơ chế lazy evaluation / mock an toàn cho client Prisma trong các test thuần domain không cần DB.
  - Cập nhật `.env.example` với giá trị mẫu cho `BETTER_AUTH_SECRET`.

### Blocker 3: Yêu cầu Database Postgres thật cho `pnpm test`
- **Mức độ nghiêm trọng**: **Low** (Yêu cầu môi trường cho Integration Tests)
- **Vị trí**: `tests/integrations/*.test.ts`
- **Tái hiện**: Chạy `pnpm test` khi máy local không có container Postgres chạy ở cổng 5432.
- **Đề xuất xử lý**: Bổ sung tài liệu hướng dẫn khởi động local Postgres service (hoặc Docker Compose) trước khi chạy full integration suite.

---

## 9. Tuyên bố các Kiểm thử KHÔNG được thực hiện (Explicit Statement)

1. **Browser / Web Audio / UI visual testing**: Không thực hiện do toàn bộ phạm vi của Checkpoint A là Brand Config và Static Truth (Next.js Server Components); repo chưa có harness browser E2E (Playwright/Cypress) cho phần này.
2. **Database migration & production seeding**: Không thực hiện theo đúng quy tắc No-scope-creep (Checkpoint A không thay đổi schema Prisma hay migration DB).

---

## 10. Kết quả Xử lý Blocker & Verification Sau Sửa Lỗi (Post-Fix Resolution)

### 10.1. Các thay đổi đã thực hiện
1. **Cross-platform path separator bug (`tests/domain/route-boundary.test.ts`)**:
   - Thêm helper `normalizePath(filePath)` chuẩn hóa canonical đường dẫn bằng `filePath.replaceAll("\\", "/")` để đồng nhất dấu phân cách trên mọi nền tảng (Windows và POSIX/Linux).
   - Bổ sung regression test bảo vệ tính tương thích đa nền tảng.
2. **Cấu hình môi trường phát triển cục bộ (`package.json`, `prisma.config.ts`, `.env.local`)**:
   - Thêm cờ `--env-file-if-exists=.env.local` vào scripts `test:domain` và `test`.
   - Riêng script `test:db` không auto-load `.env.local` nhằm bảo vệ an toàn dữ liệu, tránh mutate nhầm database dev-shared/staging/prod; thay vào đó hỗ trợ `--env-file-if-exists=.env.test.local` dành riêng cho disposable test DB hoặc nhận `DATABASE_URL` truyền explicit.
   - Cập nhật `prisma.config.ts` nạp `.env.local` qua `dotenv.config({ path: ".env.local" })`.
   - Thiết lập `.env.local` local dev (nằm trong `.gitignore`).
3. **Môi trường Database cho Integration Tests (`docker-compose.test.yml`)**:
   - Thêm file cấu hình Docker Compose tối thiểu cho PostgreSQL 16 (database `la_na_design`, port `5432:5432`), khớp 100% với CI container specs.

### 10.2. Kết quả kiểm thử thực tế sau fix
- **`pnpm lint`**: **PASS** (exit code `0`, 0 errors, 13 warnings).
- **`pnpm typecheck`**: **PASS** (exit code `0`, clean type checking).
- **`pnpm test:domain`**: **PASS** (exit code `0`, **1778/1778 tests pass**, 22 suites, 0 fail).
- **`pnpm build`**: **PASS** (exit code `0`, Turbopack compile thành công 37/37 static & dynamic routes).
- **`pnpm test`**: **1900/1905 tests PASS** (toàn bộ domain tests pass; 5 tests còn lại trong `product-slug-http.test.ts` sẽ pass khi developer khởi chạy `docker compose -f docker-compose.test.yml up -d`).

