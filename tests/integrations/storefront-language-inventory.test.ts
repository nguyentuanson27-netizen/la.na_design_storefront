import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INVENTORY_FILE = "tests/integrations/storefront-language-inventory.test.ts";
const SOURCE_ROOTS = ["src", "tests"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const NON_BUYER_PREFIXES = [
  "src/generated/",
  "src/app/admin/",
  "tests/a11y-runtime/admin-",
] as const;

/**
 * Buyer copy takes the brand name from Brand Config, so these page sources carry an interpolation
 * where they used to carry the literal. The assertions below are about the Vietnamese half of the
 * copy; spelling the brand half this way keeps them pinned to the config rather than to page prose,
 * and keeps them true for any brand this template is forked for.
 */
const BRAND_NAME_IN_JSX = "{BRAND.identity.name}";
const BRAND_NAME_IN_TEMPLATE = "${BRAND.identity.name}";

const PHRASE_TERMS = [
  "Shop the collection",
  "View collections",
  "Shop edit",
  "View all",
  "View lookbook",
  "Current edit",
  "The current edit is being prepared.",
  "Products will appear here when the shop catalog is available for the website.",
  "Shop by category",
  "Find / Discover",
  "The newest silhouettes, fabrics and seasonal layers",
  "Explore collection",
  "Current collections",
  "Collections are being prepared.",
  "Published collections will appear here as they become available.",
  "Published collections from LA Clothing.",
  "LA Clothing / Collection",
  "Current collection",
  "Collection này chưa có sản phẩm.",
  "Phân trang collection",
  "Add to Bag",
  "Túi hàng",
  "Continue shopping",
  "Color / Size unavailable",
  "Color × Size",
  "New arrivals",
  "New Arrivals",
  "Search products",
  "Customer / Account",
] as const;

const HEADING_TERMS = [
  "YOUR BAG",
  "TÚI HÀNG",
  "CHECKOUT",
  "SEARCH",
  "NEW ARRIVALS",
  "ACCOUNT",
  "COLLECTIONS",
  "SHOP",
] as const;

const EXACT_LABELS = [
  "Shop",
  "Collections",
  "Search",
  "Account",
  "Bag",
  "Cart",
] as const;

const NON_BUYER_TECHNICAL_HITS = new Set([
  "src/seo/structured-data.ts::Shop",
  "tests/domain/structured-data.test.ts::Shop",
  "tests/integrations/pancake-shops.test.ts::Shop",
]);

const PENDING_U1_BUYER_HITS = new Set<string>();

type InventoryHit = {
  path: string;
  line: number;
  term: string;
  text: string;
};

function extensionOf(path: string): string {
  const match = path.match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extensionOf(path))) continue;
    files.push(path);
  }

  return files;
}

function isExactBuyerLabelLine(line: string, label: string): boolean {
  const trimmed = line.trim();
  if (trimmed === label) return true;

  const quoted = `["'\\\`]${label}(?:\\s*↗)?["'\\\`]`;
  return new RegExp(
    `(?:>\\s*${label}(?:\\s*↗)?\\s*<|(?:label|title|name)\\s*:\\s*${quoted}|const\\s+[A-Z0-9_]+\\s*=\\s*${quoted})`,
  ).test(line);
}

function isEmbeddedBuyerLabelLine(line: string, label: string): boolean {
  if (label !== "Bag" && label !== "Cart") return false;

  const token = new RegExp("\\b" + label + "\\b");
  const jsxStart = line.indexOf(">");
  const jsxEnd = jsxStart >= 0 ? line.indexOf("<", jsxStart + 1) : -1;
  if (jsxStart >= 0 && jsxEnd > jsxStart) {
    const jsxText = line.slice(jsxStart + 1, jsxEnd);
    if (token.test(jsxText)) return true;
  }

  const copyKeys = [
    "title:",
    "label:",
    "message:",
    "description:",
    "placeholder=",
    "aria-label=",
  ];
  if (!copyKeys.some((key) => line.includes(key))) return false;

  const quotedSegments = line.match(/["'][^"']*["']/g) ?? [];
  return quotedSegments.some((segment) => token.test(segment));
}

function isTechnicalTestTitle(line: string, term: string): boolean {
  return term === "Color × Size" && /^\s*test\(/.test(line);
}

function findHits(path: string, source: string): InventoryHit[] {
  const hits: InventoryHit[] = [];

  source.split("\n").forEach((line, index) => {
    for (const term of PHRASE_TERMS) {
      if (line.includes(term) && !isTechnicalTestTitle(line, term)) {
        hits.push({ path, line: index + 1, term, text: line.trim() });
      }
    }

    for (const term of HEADING_TERMS) {
      const trimmed = line.trim();
      const quoted = `["'\\\`]${term}["'\\\`]`;
      if (
        trimmed === term ||
        new RegExp(`(?:name|title|label)\\s*:\\s*${quoted}`).test(line)
      ) {
        hits.push({ path, line: index + 1, term, text: trimmed });
      }
    }

    for (const label of EXACT_LABELS) {
      if (
        isExactBuyerLabelLine(line, label) ||
        isEmbeddedBuyerLabelLine(line, label)
      ) {
        hits.push({ path, line: index + 1, term: label, text: line.trim() });
      }
    }
  });

  return hits;
}

test("U1 inventory catches embedded buyer labels without matching technical identifiers", () => {
  assert.deepEqual(
    findHits("fixture.tsx", '<p className="eyebrow">Shopping / Bag</p>'),
    [
      {
        path: "fixture.tsx",
        line: 1,
        term: "Bag",
        text: '<p className="eyebrow">Shopping / Bag</p>',
      },
    ],
  );
  assert.deepEqual(findHits("fixture.ts", "class CartError extends Error {}"), []);
  assert.deepEqual(findHits("fixture.ts", 'const query = "FROM \\"Cart\\"";'), []);
});

test("U1b collections listing uses Vietnamese functional copy", async () => {
  const source = await readFile(join(REPO_ROOT, "src/app/collections/page.tsx"), "utf8");
  for (const expected of [
    'title: "Bộ sưu tập"',
    `description: \`Khám phá các bộ sưu tập từ ${BRAND_NAME_IN_TEMPLATE}.\``,
    "BỘ SƯU TẬP",
    "Khám phá bộ sưu tập ↗",
    "Bộ sưu tập hiện tại",
    "Các bộ sưu tập đang được chuẩn bị.",
    "Bộ sưu tập sẽ xuất hiện tại đây khi sẵn sàng.",
  ]) {
    assert.equal(source.includes(expected), true, `collections listing missing Vietnamese copy: ${expected}`);
  }
});

test("U1b shop listing and loading use Vietnamese buyer-functional copy", async () => {
  const [pageSource, loadingSource, metadataSource] = await Promise.all([
    readFile(join(REPO_ROOT, "src/app/shop/page.tsx"), "utf8"),
    readFile(join(REPO_ROOT, "src/app/shop/loading.tsx"), "utf8"),
    readFile(join(REPO_ROOT, "src/routes/metadata/shop.ts"), "utf8"),
  ]);

  // The listing's title is metadata copy, so it is checked where the canonical metadata builder
  // lives. Everything a shopper reads on the page is still checked on the page.
  assert.equal(
    metadataSource.includes('export const SHOP_TITLE = "Cửa hàng";'),
    true,
    "the shop metadata builder must carry the Vietnamese listing title",
  );

  for (const expected of [
    `${BRAND_NAME_IN_JSX} / Cửa hàng`,
    "CỬA HÀNG",
    "Khám phá sản phẩm",
    ">Bộ sưu tập<",
    "Không tìm thấy",
    "Sản phẩm hiện tại",
  ]) {
    assert.equal(pageSource.includes(expected), true, `shop listing missing Vietnamese copy: ${expected}`);
  }

  for (const oldCopy of [
    "LA Clothing / Store",
    "Tìm trong catalog",
    ">Discovery<",
    ">Collection<",
    "No match",
    "Current drop",
    "Current collection",
    "catalog mirror",
    "phía máy chủ",
  ]) {
    assert.equal(pageSource.includes(oldCopy), false, `shop listing retained old/technical copy: ${oldCopy}`);
  }

  for (const expected of [`${BRAND_NAME_IN_JSX} / Cửa hàng`, "CỬA HÀNG", "Đang tải cửa hàng."]) {
    assert.equal(loadingSource.includes(expected), true, `shop loading missing Vietnamese copy: ${expected}`);
  }
  for (const oldCopy of ["LA Clothing / Store", "SHOP", "catalog cửa hàng"]) {
    assert.equal(loadingSource.includes(oldCopy), false, `shop loading retained old copy: ${oldCopy}`);
  }
});

test("U1b collection detail uses Vietnamese buyer-functional copy", async () => {
  const source = await readFile(join(REPO_ROOT, "src/app/collections/[slug]/page.tsx"), "utf8");

  for (const expected of [
    "Bộ sưu tập",
    `${BRAND_NAME_IN_JSX} / Bộ sưu tập`,
    "Bộ sưu tập hiện tại",
    "Bộ sưu tập này chưa có sản phẩm.",
    "Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập.",
    'aria-label="Phân trang bộ sưu tập"',
    "Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.",
  ]) {
    assert.equal(source.includes(expected), true, `collection detail missing Vietnamese copy: ${expected}`);
  }

  for (const oldCopy of [
    "Collections",
    "LA Clothing / Collection",
    "Current collection",
    "Collection này chưa có sản phẩm.",
    "Membership của collection",
    "catalog mirror",
    'aria-label="Phân trang collection"',
  ]) {
    assert.equal(source.includes(oldCopy), false, `collection detail retained old/technical copy: ${oldCopy}`);
  }
});

test("U1b purchase panel uses Vietnamese buyer-functional copy", async () => {
  // The panel's markup moved to the brand layer, so the copy is checked where it now lives. The
  // commerce module that kept the panel's public surface is checked too, so a shim that starts
  // carrying shopper-facing copy again does not slip past this inventory.
  const source = await readFile(
    join(REPO_ROOT, "src/components/brand/purchase-panel.tsx"),
    "utf8",
  );
  const shimSource = await readFile(
    join(REPO_ROOT, "src/components/commerce/product-purchase-panel.tsx"),
    "utf8",
  );

  for (const expected of [
    "Thêm vào giỏ hàng",
    "Chọn loại × kích cỡ × màu",
    "Chọn loại × kích cỡ",
    "Chọn màu × kích cỡ",
    "Chọn kích cỡ",
  ]) {
    assert.equal(source.includes(expected), true, `purchase panel missing Vietnamese copy: ${expected}`);
  }

  for (const oldCopy of [
    "Add to Bag",
    "Chọn Loại × Size × Màu",
    "Chọn Loại × Size",
    "Chọn Color × Size",
    "Chọn Size",
  ]) {
    assert.equal(source.includes(oldCopy), false, `purchase panel retained old copy: ${oldCopy}`);
    assert.equal(shimSource.includes(oldCopy), false, `purchase panel shim retained old copy: ${oldCopy}`);
  }
});

test("U1b PDP uses Vietnamese buyer-functional copy and preserves availability disclosure", async () => {
  const source = await readFile(join(REPO_ROOT, "src/app/shop/[slug]/page.tsx"), "utf8");

  for (const expected of [
    "Cửa hàng",
    `${BRAND_NAME_IN_JSX} / Sản phẩm`,
    "Hướng dẫn chọn kích cỡ",
    "Bảo quản",
    "Tình trạng còn hàng được hệ thống kiểm tra lại khi bạn thêm sản phẩm vào giỏ hàng.",
    "Số lượng tồn kho chính xác không được hiển thị trên website.",
  ]) {
    assert.equal(source.includes(expected), true, `PDP missing Vietnamese/factual copy: ${expected}`);
  }

  for (const oldCopy of [
    "LA Clothing / Product",
    ">Size guide<",
    ">Care<",
    "Add to Bag",
    "phía máy chủ",
    "client",
  ]) {
    assert.equal(source.includes(oldCopy), false, `PDP retained old/technical copy: ${oldCopy}`);
  }

  assert.equal(source.includes('href="/size-guide"'), false, "U1b must not add /size-guide before U5");
});

test("U1c cart loading and error states use Giỏ hàng terminology", async () => {
  const [loadingSource, errorSource] = await Promise.all([
    readFile(join(REPO_ROOT, "src/app/cart/loading.tsx"), "utf8"),
    readFile(join(REPO_ROOT, "src/app/cart/error.tsx"), "utf8"),
  ]);

  for (const expected of ["Mua sắm / Giỏ hàng", "Đang tải giỏ hàng."]) {
    assert.equal(loadingSource.includes(expected), true, `cart loading missing Vietnamese copy: ${expected}`);
  }
  assert.equal(loadingSource.includes("Shopping / Bag"), false, "cart loading retained Shopping / Bag");

  for (const expected of ["Mua sắm / Giỏ hàng", "GIỎ HÀNG", "Không thể tải giỏ hàng lúc này."]) {
    assert.equal(errorSource.includes(expected), true, `cart error missing Vietnamese copy: ${expected}`);
  }
  for (const oldCopy of ["Shopping / Bag", "YOUR BAG"]) {
    assert.equal(errorSource.includes(oldCopy), false, `cart error retained old copy: ${oldCopy}`);
  }
});

test("U1 inventory has no unexplained locked old buyer-copy literals", async () => {
  const files = (
    await Promise.all(
      SOURCE_ROOTS.map((root) => listSourceFiles(join(REPO_ROOT, root))),
    )
  ).flat();

  const hits: InventoryHit[] = [];
  for (const absolutePath of files) {
    const path = relative(REPO_ROOT, absolutePath).replaceAll("\\", "/");
    if (
      path === INVENTORY_FILE ||
      NON_BUYER_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      continue;
    }

    const source = await readFile(absolutePath, "utf8");
    hits.push(...findHits(path, source));
  }

  const unexpected = hits.filter(({ path, term }) => {
    const key = `${path}::${term}`;
    return !PENDING_U1_BUYER_HITS.has(key) && !NON_BUYER_TECHNICAL_HITS.has(key);
  });

  assert.deepEqual(
    unexpected,
    [],
    `Unclassified locked buyer-copy hits:\n${JSON.stringify(unexpected, null, 2)}`,
  );

  const observedPending = new Set(
    hits
      .map(({ path, term }) => `${path}::${term}`)
      .filter((key) => PENDING_U1_BUYER_HITS.has(key)),
  );

  assert.deepEqual(
    [...observedPending].sort(),
    [...PENDING_U1_BUYER_HITS].sort(),
    "The reviewed U1 buyer-functional/test-assertion inventory drifted",
  );
});
