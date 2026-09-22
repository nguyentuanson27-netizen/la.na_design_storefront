import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

test("mobile independent UX: header exposes menu, logo, search and cart with practical targets while Account stays in menu", () => {
  const header = read("src/components/brand/site-header.tsx");
  const css = read("src/app/globals.css");

  assert.match(header, /className=\{isAccount \? "mobile-account-link" : undefined\}/);
  assert.match(css, /\.mobile-account-link\s*\{[^}]*display:\s*none;/);
  assert.doesNotMatch(css, /\.utility-nav\s+a:not\(:last-child\),\s*\.utility-nav\s+button:not\(:last-child\)/);
  assert.match(css, /\.mobile-nav\s+button,[\s\S]*\.utility-nav\s+button[^{]*\{[^}]*min-width:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);/);
  assert.match(header, /const destination = item\.href === "\/account"[\s\S]*className="mobile-menu__utility-link"/);
});

test("mobile independent UX: phone listing grid is two columns with a 2px rhythm and compact card type", () => {
  const chrome = read("src/components/brand/listing-chrome.tsx");
  const card = read("src/components/brand/product-card.tsx");

  assert.match(chrome, /grid-cols-2 gap-\[2px\]/);
  assert.match(chrome, /lg:grid-cols-4/);
  assert.match(card, /product-title[^"]*text-sm[^"]*line-clamp-2/);
  assert.match(card, /product-price[^"]*text-\[15px\]/);
  assert.match(card, /product-availability[^"]*text-xs/);
});

test("mobile independent UX: PLP mobile drawer keeps URL-backed filter navigation open and owns a fixed clear/view footer", () => {
  const panel = read("src/components/brand/plp-filter-panel.tsx");

  assert.match(panel, />Bộ lọc<\/span>[\s\S]*aria-hidden="true"[^>]*>·<\/span>[\s\S]*>\s*Sắp xếp:/);
  assert.doesNotMatch(panel, /router\.push\(href\);\s*setIsMobileOpen\(false\)/);
  assert.doesNotMatch(panel, /href=\{saleHref\}[\s\S]{0,180}onClick=\{\(\) => setIsMobileOpen\(false\)\}/);
  assert.doesNotMatch(panel, /href=\{sizeHref\}[\s\S]{0,180}onClick=\{\(\) => setIsMobileOpen\(false\)\}/);
  assert.doesNotMatch(panel, /href=\{colorHref\}[\s\S]{0,180}onClick=\{\(\) => setIsMobileOpen\(false\)\}/);
  assert.doesNotMatch(panel, /fixed inset-0 bg-black\/40 backdrop-blur-sm transition-opacity"[\s\S]{0,120}onClick=\{\(\) => setIsMobileOpen\(false\)\}/);
  assert.match(panel, /className="mobile-plp-filter-footer/);
  assert.match(panel, /Xóa bộ lọc/);
  assert.match(panel, /Xem \{totalCount\} sản phẩm/);
  assert.match(panel, /onClick=\{\(\) => setIsMobileOpen\(false\)\}[\s\S]{0,500}Xem \{totalCount\} sản phẩm/);
});

test("mobile independent UX: cart drawer quantity controls are practical touch targets and remove stays separate", () => {
  const drawer = read("src/components/brand/cart-drawer.tsx");

  const quantityBlock = drawer.slice(drawer.indexOf("Quantity & Remove"), drawer.indexOf("Footer"));
  assert.match(quantityBlock, /h-11 w-11/);
  assert.doesNotMatch(quantityBlock, /h-7 w-7/);
  assert.match(quantityBlock, /aria-label=\{\`Giảm số lượng/);
  assert.match(quantityBlock, /aria-label=\{\`Tăng số lượng/);
  assert.match(quantityBlock, />\s*Xóa\s*<\/button>/);
});

test("mobile independent UX: checkout mobile reading order is summary, receiving info, totals/preorder, then the existing submit workflow", () => {
  const page = read("src/app/checkout/page.tsx");
  const form = read("src/components/commerce/guest-checkout-form.tsx");

  assert.match(page, /lines\.reduce\(\(count, line\) => count \+ line\.quantity, 0\)/);
  assert.match(page, /Đơn hàng \(\{itemCount\}\) · \{totals\.totalText\}/);
  assert.match(form, /summaryLabel[\s\S]*aria-expanded=\{isSummaryOpen\}/);
  assert.equal((page.match(/\{orderLines\}/g) ?? []).length, 1);
  assert.equal((page.match(/\{totalsBlock\}/g) ?? []).length, 1);
  assert.equal((page.match(/<BrandPreorderFulfillmentNotice notice=\{data\.preorderNotice\} \/>/g) ?? []).length, 1);
  assert.match(page, /text-\[2\.5rem\]/);
  assert.match(page, /lg:text-\[clamp\(3\.5rem,10vw,9rem\)\]/);
  assert.doesNotMatch(page, /Đây là số tiền dự kiến\. Máy chủ/);
  assert.doesNotMatch(form, /Danh sách tỉnh\/thành gồm cả dữ liệu địa giới cũ và mới từ Pancake/);
  assert.doesNotMatch(form, /Giá, tồn kho và địa chỉ sẽ được máy chủ kiểm tra lại trước khi tạo đơn trên Pancake/);

  assert.match(form, /\{summarySlot\}[\s\S]*checkout-receiving-fields[\s\S]*\{totalsSlot\}[\s\S]*\{preorderSlot\}[\s\S]*type="submit"/);
  assert.match(form, /submitGuestCheckoutAction/);
  assert.match(form, /PRICE_CHANGED/);
});
