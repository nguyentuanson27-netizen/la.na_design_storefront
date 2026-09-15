import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BRAND } from "../../src/brand/index.ts";

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
 * Three kinds of rule live in this file, and they are not maintained the same way.
 *
 *   A — banned English buyer phrases (`PHRASE_TERMS`, `HEADING_TERMS`, `EXACT_LABELS`, and the
 *       inline `oldCopy` loops). Nothing about them is brand-specific, so they stay as plain source
 *       greps and their sets only ever grow.
 *   B — banned technical vocabulary leaking into the shopfront ("catalog mirror", "phía máy chủ",
 *       "client"). Also brand-independent; also plain greps.
 *   C — required Vietnamese copy that carries the brand name. These are the only ones the template
 *       breaks, because the page now interpolates the name instead of spelling it. They are checked
 *       as patterns here and as rendered text in Playwright, and both halves derive the name from
 *       `BRAND` rather than repeating a literal.
 *
 * Most of the value is in A and B, and A and B needed no change.
 */

/**
 * How buyer copy spells the brand half, in source. Pages interpolate the name, so a C rule matches
 * the interpolation rather than a baked-in literal -- that is what makes it true for any brand this
 * template is forked for.
 */
const BRAND_NAME_IN_JSX = "{BRAND.identity.name}";
const BRAND_NAME_IN_TEMPLATE = "${BRAND.identity.name}";

/**
 * The brand-coupled copy shapes this storefront must never render, built from the configured name.
 *
 * `LA Clothing / Store` is banned as a literal below and stays banned: it is the template's own
 * origin copy and must not come back. But a fork renames the brand, and on that fork the literal
 * can never match again -- the protection would quietly evaporate exactly when the redesign that
 * needs it happens. Deriving the same shapes from `BRAND.identity.name` keeps the ban alive for
 * whatever the brand is called, so these are additions to the A/B sets, never replacements.
 */
function brandEyebrow(suffix: string, brandName: string = BRAND.identity.name): string {
  return `${brandName} / ${suffix}`;
}

/** A — banned English buyer phrases. Brand-independent; this set only grows. */
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

/** A — banned English headings. Brand-independent. */
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

/** A — banned standalone English labels. Brand-independent. */
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

test("C rules follow the configured brand name, so a fork inherits them", () => {
  // The rename proof. A C rule has to keep meaning the same thing after `BRAND.identity.name`
  // changes -- that is the whole reason these stopped being literals. `brandEyebrow` takes the name
  // as a parameter so the rename can be exercised here rather than only by editing brand config and
  // re-running, though that was done too and is recorded in the Phase F notes.
  assert.equal(brandEyebrow("Store", "Nguyễn Atelier"), "Nguyễn Atelier / Store");
  assert.equal(brandEyebrow("Product", "Xưởng May 1975"), "Xưởng May 1975 / Product");
  assert.equal(brandEyebrow("Store"), `${BRAND.identity.name} / Store`);

  // The source patterns match the interpolation a page actually writes, so they must not contain a
  // brand name at all. If they ever did, they would pass for this brand and silently stop checking
  // anything for the next one.
  for (const pattern of [BRAND_NAME_IN_JSX, BRAND_NAME_IN_TEMPLATE]) {
    assert.equal(
      pattern.includes(BRAND.identity.name),
      false,
      `C source pattern must not bake in a brand name: ${pattern}`,
    );
    assert.match(pattern, /BRAND\.identity\.name/);
  }

  // The origin brand's own copy stays banned as a literal regardless of who forks the template, so
  // converting C rules to derived ones never shrank the A sets.
  assert.equal(PHRASE_TERMS.includes("LA Clothing / Collection"), true);
  assert.equal(PHRASE_TERMS.includes("Published collections from LA Clothing."), true);
});

test("U1b collections listing uses Vietnamese functional copy", async () => {
  // The listing's title and description are metadata copy and are checked where the canonical
  // metadata builder lives; everything a shopper reads is still checked on the page.
  const [source, metadataSource] = await Promise.all([
    readFile(join(REPO_ROOT, "src/app/collections/page.tsx"), "utf8"),
    readFile(join(REPO_ROOT, "src/routes/metadata/collections.ts"), "utf8"),
  ]);
  for (const expected of [
    'title: "Bộ sưu tập"',
    `description: \`Khám phá các bộ sưu tập từ ${BRAND_NAME_IN_TEMPLATE}.\``,
  ]) {
    assert.equal(
      metadataSource.includes(expected),
      true,
      `collections metadata missing Vietnamese copy: ${expected}`,
    );
  }
  for (const expected of [
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
    // A — the template's own origin copy, banned as a literal so it cannot come back.
    "LA Clothing / Store",
    ">Discovery<",
    ">Collection<",
    "No match",
    "Current drop",
    "Current collection",
    // B — technical vocabulary that must not reach a shopper.
    "Tìm trong catalog",
    "catalog mirror",
    "phía máy chủ",
    // C — the same eyebrow shape, derived, so the ban survives a rename.
    brandEyebrow("Store"),
  ]) {
    assert.equal(pageSource.includes(oldCopy), false, `shop listing retained old/technical copy: ${oldCopy}`);
  }

  for (const expected of [`${BRAND_NAME_IN_JSX} / Cửa hàng`, "CỬA HÀNG", "Đang tải cửa hàng."]) {
    assert.equal(loadingSource.includes(expected), true, `shop loading missing Vietnamese copy: ${expected}`);
  }
  for (const oldCopy of [
    "LA Clothing / Store", // A
    "SHOP", // A
    "catalog cửa hàng", // B
    brandEyebrow("Store"), // C
  ]) {
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
    // A
    "Collections",
    "LA Clothing / Collection",
    "Current collection",
    "Collection này chưa có sản phẩm.",
    'aria-label="Phân trang collection"',
    // B
    "Membership của collection",
    "catalog mirror",
    // C
    brandEyebrow("Collection"),
  ]) {
    assert.equal(source.includes(oldCopy), false, `collection detail retained old/technical copy: ${oldCopy}`);
  }
});

test("U1b purchase panel uses Vietnamese buyer-functional copy", async () => {
  // The panel's markup moved to the brand layer, so the copy is checked where it now lives. The
  // commerce shim that used to keep the panel's public surface is gone: every route renders the
  // brand panel directly, so there is no second file left to carry this copy. A shim coming back
  // with shopper-facing copy is caught by the repo-wide inventory below rather than here.
  const source = await readFile(
    join(REPO_ROOT, "src/components/brand/purchase-panel.tsx"),
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
    // A
    "LA Clothing / Product",
    ">Size guide<",
    ">Care<",
    "Add to Bag",
    // B
    "phía máy chủ",
    "client",
    // C
    brandEyebrow("Product"),
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
