import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import {
  createProductContentAdminService,
  parseSizeGuideField,
} from "../../src/commerce/product-content-admin.ts";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN" },
  session: { id: "session-admin" },
} as const;

const customerSession = {
  user: { id: "customer-1", role: "CUSTOMER" },
  session: { id: "session-customer" },
} as const;

function validInput() {
  return {
    productId: "product-1",
    status: "PUBLISHED",
    editorialDescription: "  Relaxed tailoring for everyday movement.  ",
    careInstructions: " Cold wash. ",
    sizeGuide: " ",
    seoTitle: "  Relaxed Oxford Shirt  ",
    seoDescription: " Editorial menswear shirt. ",
    collectionSlugs: " essentials, city-uniform ",
  };
}

function passThroughCollections(collectionSlugs: string[]) {
  return Promise.resolve([...collectionSlugs].sort());
}

test("product editorial updates require ADMIN before reading or writing content", async () => {
  let dependencyCalls = 0;
  const service = createProductContentAdminService({
    async productExists() {
      dependencyCalls += 1;
      return true;
    },
    async resolveCollectionSlugs() {
      dependencyCalls += 1;
      return [];
    },
    async saveContent() {
      dependencyCalls += 1;
      throw new Error("must not write");
    },
  });

  await assert.rejects(
    () => service.update(customerSession, validInput()),
    (error: unknown) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "FORBIDDEN");
      return true;
    },
  );
  assert.equal(dependencyCalls, 0);
});

test("product editorial updates reject malformed browser input before database access", async () => {
  let dependencyCalls = 0;
  const service = createProductContentAdminService({
    async productExists() {
      dependencyCalls += 1;
      return true;
    },
    async resolveCollectionSlugs() {
      dependencyCalls += 1;
      return [];
    },
    async saveContent() {
      dependencyCalls += 1;
      throw new Error("must not write");
    },
  });

  for (const input of [
    { ...validInput(), productId: " product-1" },
    { ...validInput(), status: "published" },
    { ...validInput(), status: "ARCHIVED" },
    { ...validInput(), status: 123 },
    { ...validInput(), seoTitle: 123 },
    { ...validInput(), collectionSlugs: "../sale" },
    { ...validInput(), collectionSlugs: "city-uniform, city-uniform" },
    { ...validInput(), collectionSlugs: Array.from({ length: 9 }, (_, index) => `edit-${index}`).join(",") },
  ]) {
    assert.deepEqual(await service.update(adminSession, input), {
      ok: false,
      reason: "INVALID_INPUT",
    });
  }
  assert.equal(dependencyCalls, 0);
});

test("product editorial updates fail closed when the mirrored product does not exist", async () => {
  let collectionCalls = 0;
  let saveCalls = 0;
  const service = createProductContentAdminService({
    async productExists(productId) {
      assert.equal(productId, "product-1");
      return false;
    },
    async resolveCollectionSlugs() {
      collectionCalls += 1;
      return [];
    },
    async saveContent() {
      saveCalls += 1;
      throw new Error("must not write");
    },
  });

  assert.deepEqual(await service.update(adminSession, validInput()), {
    ok: false,
    reason: "PRODUCT_NOT_FOUND",
  });
  assert.equal(collectionCalls, 0);
  assert.equal(saveCalls, 0);
});

test("product editorial updates fail closed when collection membership is stale or unknown", async () => {
  let saveCalls = 0;
  const service = createProductContentAdminService({
    async productExists() {
      return true;
    },
    async resolveCollectionSlugs(collectionSlugs) {
      assert.deepEqual(collectionSlugs, ["essentials", "city-uniform"]);
      return null;
    },
    async saveContent() {
      saveCalls += 1;
      throw new Error("must not write");
    },
  });

  assert.deepEqual(await service.update(adminSession, validInput()), {
    ok: false,
    reason: "COLLECTION_NOT_FOUND",
  });
  assert.equal(saveCalls, 0);
});

test("product editorial updates preserve old form submissions with no collection field", async () => {
  const writes: unknown[] = [];
  let collectionCalls = 0;
  const service = createProductContentAdminService({
    async productExists() {
      return true;
    },
    async resolveCollectionSlugs(collectionSlugs) {
      collectionCalls += 1;
      return passThroughCollections(collectionSlugs);
    },
    async saveContent(content) {
      writes.push(content);
      return { ok: true, content };
    },
  });

  const { collectionSlugs, ...legacyInput } = validInput();
  void collectionSlugs;
  const nullFieldInput = { ...legacyInput, collectionSlugs: null };

  for (const input of [legacyInput, nullFieldInput]) {
    const result = await service.update(adminSession, input);
    assert.equal(result.ok, true);
  }

  assert.equal(collectionCalls, 0);
  assert.deepEqual(
    writes.map((write) => (write as { collectionSlugs: string[] }).collectionSlugs),
    [[], []],
  );
});

test("legacy product editorial submissions without publication status default fail-closed to DRAFT", async () => {
  const writes: unknown[] = [];
  const service = createProductContentAdminService({
    async productExists() {
      return true;
    },
    async resolveCollectionSlugs(collectionSlugs) {
      return passThroughCollections(collectionSlugs);
    },
    async saveContent(content) {
      writes.push(content);
      return { ok: true, content };
    },
  });

  const { status, ...legacyInput } = validInput();
  void status;

  const result = await service.update(adminSession, legacyInput);
  assert.equal(result.ok, true);
  assert.equal((writes[0] as { status?: string }).status, "DRAFT");
});

test("product editorial updates persist canonical membership and explicit publication state without source fields", async () => {
  const writes: unknown[] = [];
  const service = createProductContentAdminService({
    async productExists(productId) {
      assert.equal(productId, "product-1");
      return true;
    },
    async resolveCollectionSlugs(collectionSlugs) {
      assert.deepEqual(collectionSlugs, ["essentials", "city-uniform"]);
      return passThroughCollections(collectionSlugs);
    },
    async saveContent(content) {
      writes.push(content);
      return { ok: true, content };
    },
  });

  const result = await service.update(adminSession, {
    ...validInput(),
    sourceDescription: "forged source field must never become website-owned content",
  });

  assert.deepEqual(writes, [
    {
      productId: "product-1",
      status: "PUBLISHED",
      editorialDescription: "Relaxed tailoring for everyday movement.",
      careInstructions: "Cold wash.",
      sizeGuide: null,
      seoTitle: "Relaxed Oxford Shirt",
      seoDescription: "Editorial menswear shirt.",
      collectionSlugs: ["city-uniform", "essentials"],
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    content: writes[0],
  });
});

test("M1 parseSizeGuideField accepts the 3 approved IDs and rejects arbitrary or legacy values", () => {
  // Approved guide IDs
  assert.deepEqual(parseSizeGuideField("ao-dai"), { ok: true, value: "ao-dai" });
  assert.deepEqual(parseSizeGuideField("set-vay-form-rong"), {
    ok: true,
    value: "set-vay-form-rong",
  });
  assert.deepEqual(parseSizeGuideField("set-vay-form-nho"), {
    ok: true,
    value: "set-vay-form-nho",
  });

  // Trimming surrounding whitespace
  assert.deepEqual(parseSizeGuideField("  ao-dai  "), { ok: true, value: "ao-dai" });
  assert.deepEqual(parseSizeGuideField("\nset-vay-form-rong\t"), {
    ok: true,
    value: "set-vay-form-rong",
  });

  // Nullable/empty unassigned cases
  assert.deepEqual(parseSizeGuideField(null), { ok: true, value: null });
  assert.deepEqual(parseSizeGuideField(undefined), { ok: true, value: null });
  assert.deepEqual(parseSizeGuideField(""), { ok: true, value: null });
  assert.deepEqual(parseSizeGuideField("   "), { ok: true, value: null });

  // Rejects arbitrary strings
  assert.deepEqual(parseSizeGuideField("random-guide"), { ok: false });
  assert.deepEqual(parseSizeGuideField("model-is-180cm"), { ok: false });
  assert.deepEqual(parseSizeGuideField("oversized"), { ok: false });

  // Rejects legacy menswear values
  assert.deepEqual(parseSizeGuideField("menswear-relaxed"), { ok: false });
  assert.deepEqual(parseSizeGuideField("chart-a"), { ok: false });
  assert.deepEqual(parseSizeGuideField("chart-b"), { ok: false });
  assert.deepEqual(parseSizeGuideField("Relaxed fit."), { ok: false });

  // Rejects category keys / paths
  assert.deepEqual(parseSizeGuideField("aoDaiTet"), { ok: false });
  assert.deepEqual(parseSizeGuideField("aoDaiCachTan"), { ok: false });
  assert.deepEqual(parseSizeGuideField("setVay"), { ok: false });
  assert.deepEqual(parseSizeGuideField("/ao-dai"), { ok: false });

  // Rejects collection slugs
  assert.deepEqual(parseSizeGuideField("essentials"), { ok: false });
  assert.deepEqual(parseSizeGuideField("city-uniform"), { ok: false });

  // Rejects non-string types
  assert.deepEqual(parseSizeGuideField(123), { ok: false });
  assert.deepEqual(parseSizeGuideField(true), { ok: false });
  assert.deepEqual(parseSizeGuideField({}), { ok: false });
  assert.deepEqual(parseSizeGuideField([]), { ok: false });
});

test("M1 product editorial updates reject unapproved size-guide values fail-closed before database access", async () => {
  let dependencyCalls = 0;
  const service = createProductContentAdminService({
    async productExists() {
      dependencyCalls += 1;
      return true;
    },
    async resolveCollectionSlugs() {
      dependencyCalls += 1;
      return [];
    },
    async saveContent() {
      dependencyCalls += 1;
      throw new Error("must not write");
    },
  });

  for (const invalidSizeGuide of [
    "random-guide",
    "menswear-relaxed",
    "chart-a",
    "Relaxed fit.",
    "aoDaiTet",
    "aoDaiCachTan",
    "setVay",
    "/ao-dai",
    "essentials",
    123,
    true,
    {},
    [],
  ]) {
    const result = await service.update(adminSession, {
      ...validInput(),
      sizeGuide: invalidSizeGuide,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "INVALID_INPUT",
    });
  }
  assert.equal(dependencyCalls, 0);
});

test("M1 product editorial updates persist approved size-guide selections and clear when unassigned", async () => {
  const writes: unknown[] = [];
  const service = createProductContentAdminService({
    async productExists() {
      return true;
    },
    async resolveCollectionSlugs(collectionSlugs) {
      return passThroughCollections(collectionSlugs);
    },
    async saveContent(content) {
      writes.push(content);
      return { ok: true, content };
    },
  });

  // 1. Assign "ao-dai"
  const r1 = await service.update(adminSession, { ...validInput(), sizeGuide: "ao-dai" });
  assert.equal(r1.ok, true);

  // 2. Assign "set-vay-form-rong"
  const r2 = await service.update(adminSession, { ...validInput(), sizeGuide: "set-vay-form-rong" });
  assert.equal(r2.ok, true);

  // 3. Assign "set-vay-form-nho"
  const r3 = await service.update(adminSession, { ...validInput(), sizeGuide: "set-vay-form-nho" });
  assert.equal(r3.ok, true);

  // 4. Assign trimmed "  ao-dai  "
  const r4 = await service.update(adminSession, { ...validInput(), sizeGuide: "  ao-dai  " });
  assert.equal(r4.ok, true);

  // 5. Unassign with ""
  const r5 = await service.update(adminSession, { ...validInput(), sizeGuide: "" });
  assert.equal(r5.ok, true);

  // 6. Unassign with null
  const r6 = await service.update(adminSession, { ...validInput(), sizeGuide: null });
  assert.equal(r6.ok, true);

  // 7. Unassign with whitespace "   "
  const r7 = await service.update(adminSession, { ...validInput(), sizeGuide: "   " });
  assert.equal(r7.ok, true);

  assert.deepEqual(
    writes.map((w) => (w as { sizeGuide?: string | null }).sizeGuide),
    [
      "ao-dai",
      "set-vay-form-rong",
      "set-vay-form-nho",
      "ao-dai",
      null,
      null,
      null,
    ],
  );
});

