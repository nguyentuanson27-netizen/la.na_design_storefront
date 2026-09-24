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
  assert.match(card, /aspect-\[2\/3\]/, "ProductCard visual frame must pin 2:3 portrait aspect ratio");
  assert.doesNotMatch(card, /aspect-\[4\/5\]|aspect-\[3\/4\]/, "ProductCard must not revert to 4:5 or 3:4");
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
  // `summaryLabel` is a prop, so the label is a template literal rather than JSX interpolation.
  // `N` is the summed quantity pinned by the reduce above, not the number of lines.
  assert.match(page, /summaryLabel=\{`Đơn hàng \(\$\{itemCount\}\) · \$\{totals\.totalText\}`\}/);
  assert.match(form, /summaryLabel[\s\S]*aria-expanded=\{isSummaryOpen\}/);
  // Each region's markup is authored exactly once and composed into both breakpoint layouts. The
  // uses are allowed to be plural -- the declarations are not, because a second copy of the lines
  // or the totals is a second place for them to drift from the view model.
  assert.equal((page.match(/const orderLines = \(/g) ?? []).length, 1);
  assert.equal((page.match(/const totalsBlock = \(/g) ?? []).length, 1);
  assert.equal((page.match(/const estimateNote = \(/g) ?? []).length, 1);
  assert.equal((page.match(/const preorderNoticeFor = /g) ?? []).length, 1);
  assert.equal((page.match(/<BrandPreorderFulfillmentNotice/g) ?? []).length, 1);
  // Each composition's copy names its own heading: two identical ids would be one ambiguous IDREF,
  // and `display: none` does not make a duplicate id valid.
  assert.match(page, /titleId=\{`preorder-fulfillment-title-\$\{surface\}`\}/);
  assert.match(page, /preorderNoticeFor\("mobile"\)/);
  assert.match(page, /preorderNoticeFor\("desktop"\)/);

  /*
   * The desktop order panel this spec must not have changed.
   *
   * PR #52 is mobile-only, and an earlier revision folded the right-hand sticky aside into the
   * form's grid for every viewport -- which silently unstuck the desktop order summary and
   * retitled it. The aside is `lg`-only and sticky; the form's copies of the same three regions
   * are `lg:hidden`, so exactly one of each is live at any width.
   */
  assert.match(page, /<aside className="checkout-order-panel hidden h-fit border-t border-black pt-6 lg:sticky lg:top-24 lg:block">/);
  assert.match(page, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(20rem,0\.42fr\)\]/);
  assert.match(page, /<p className="text-xs font-semibold uppercase tracking-\[0\.14em\]">Đơn hàng<\/p>/);
  assert.match(form, /className="checkout-order-summary lg:hidden"/);
  assert.match(form, /className="checkout-totals lg:hidden"/);
  assert.match(form, /className="checkout-preorder lg:hidden"/);
  // The heading is the shared page header's, sized once for every page rather than per breakpoint here.
  assert.match(page, /<PageHeader eyebrow="Mua sắm" title="Thanh toán" meta="Thanh toán khi nhận hàng" \/>/);
  assert.doesNotMatch(page, /Đây là số tiền dự kiến\. Máy chủ/);
  assert.doesNotMatch(form, /Danh sách tỉnh\/thành gồm cả dữ liệu địa giới cũ và mới từ Pancake/);
  assert.doesNotMatch(form, /Giá, tồn kho và địa chỉ sẽ được máy chủ kiểm tra lại trước khi tạo đơn trên Pancake/);

  assert.match(form, /\{summarySlot\}[\s\S]*checkout-receiving-fields[\s\S]*\{totalsSlot\}[\s\S]*\{preorderSlot\}[\s\S]*type="submit"/);
  assert.match(form, /submitGuestCheckoutAction/);
  assert.match(form, /PRICE_CHANGED/);
});

test("mobile independent UX: PDP compact amendment keeps responsive density and accessible size-guide data", () => {
  const page = read("src/app/shop/[slug]/page.tsx");
  const panel = read("src/components/brand/purchase-panel.tsx");
  const css = read("src/app/globals.css");

  assert.match(css, /@media \(max-width: 63\.999rem\)[\s\S]*\.product-page-hero\s*\{[^}]*aspect-ratio:\s*2 \/ 3;/);
  assert.match(page, /<p className="eyebrow hidden lg:block">\{BRAND\.identity\.name\} \/ Sản phẩm<\/p>/);
  assert.match(page, /<h1 className="mt-0[^"]*lg:mt-5/);

  // One compact selector system now spans mobile, desktop and the quick sheet. Chips are drawn
  // 32px tall and 44px wide, and each sits in a label padded to the 44px practical touch target,
  // while desktop no longer re-expands the group spacing.
  assert.match(panel, /min-h-8 min-w-11[^"]*bg-\[#3B2219\]\/5[^"]*px-4/);
  assert.match(panel, /function choiceTarget\(disabled: boolean\) \{\s*return `py-1\.5 /);
  assert.doesNotMatch(panel, /lg:mt-7/);
  assert.match(panel, /function renderSelectorLegend/);
  assert.match(panel, /renderSelectorLegend\("Loại", selectedKindLabel\)/);
  assert.match(panel, /renderSelectorLegend\("Kích cỡ", selection\.size\)/);
  // The colour legend defaults to "Màu" and takes a product's own dimension label when it has one
  // (SD007 reads "Màu quần"), so the default is pinned alongside the override that replaces it.
  assert.match(panel, /renderSelectorLegend\(view\.colorDimensionLabel \?\? "Màu", selection\.color\)/);
  assert.match(panel, /function renderSizeGuideTrigger\(surface: "panel" \| "sheet"\)/);
  assert.match(panel, /\{renderSizeGuideTrigger\(surface\)\}/);

  const guideStart = panel.indexOf("function MappedSizeGuideDialog");
  const guideEnd = panel.indexOf("export function PurchasePanelView");
  const guide = panel.slice(guideStart, guideEnd);
  assert.doesNotMatch(guide, /<h2|>Hướng dẫn chọn size<\/p>/);
  assert.match(
    guide,
    /className="sr-only"[\s\S]*guide\.circumferenceSemanticsNote[\s\S]*guide\.tolerance[\s\S]*guide\.guidanceNote[\s\S]*<table>/,
  );
  assert.match(guide, /aria-label=\{\`Hướng dẫn chọn size: \$\{guide\.chart\.title\}\`\}/);
  assert.match(guide, /border-0 bg-transparent/);
});
