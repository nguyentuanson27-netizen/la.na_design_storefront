import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { CollectionDefinitionError } from "../../src/commerce/collection-definition.ts";
import { createCollectionDefinitionAdminService } from "../../src/commerce/collection-definition-admin.ts";

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
    slug: " city-uniform ",
    title: " City Uniform ",
    description: " Daily tailoring and essentials. ",
    seoTitle: " City Uniform | LA Clothing ",
    seoDescription: " Everyday menswear essentials. ",
    isPublished: "on",
    homepagePosition: "2",
    pancakeCategoryIds: "42, 7",
  };
}

test("collection admin requires ADMIN before parsing or persistence", async () => {
  let saves = 0;
  const service = createCollectionDefinitionAdminService({
    async saveDefinition() {
      saves += 1;
      throw new Error("must not write");
    },
  });

  await assert.rejects(
    () => service.save(customerSession, validInput()),
    (error: unknown) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "FORBIDDEN");
      return true;
    },
  );
  assert.equal(saves, 0);
});

test("collection admin normalizes browser form values and persists through the reviewed definition boundary", async () => {
  const writes: unknown[] = [];
  const service = createCollectionDefinitionAdminService({
    async saveDefinition(definition) {
      writes.push(definition);
      return definition;
    },
  });

  const result = await service.save(adminSession, validInput());

  assert.deepEqual(writes, [
    {
      slug: "city-uniform",
      title: "City Uniform",
      description: "Daily tailoring and essentials.",
      seoTitle: "City Uniform | LA Clothing",
      seoDescription: "Everyday menswear essentials.",
      isPublished: true,
      homepagePosition: 2,
      indexPosition: null,
      pancakeCategoryIds: [7, 42],
    },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.definition.homepagePosition, 2);
    assert.deepEqual(result.definition.pancakeCategoryIds, [7, 42]);
  }
});

test("collection admin keeps publication and homepage merchandising opt-in by default", async () => {
  const writes: unknown[] = [];
  const service = createCollectionDefinitionAdminService({
    async saveDefinition(definition) {
      writes.push(definition);
      return definition;
    },
  });

  const result = await service.save(adminSession, {
    slug: "essentials",
    title: "Essentials",
    description: "Core pieces.",
    seoTitle: "",
    seoDescription: null,
    isPublished: null,
    homepagePosition: "",
    pancakeCategoryIds: "",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, [
    {
      slug: "essentials",
      title: "Essentials",
      description: "Core pieces.",
      seoTitle: null,
      seoDescription: null,
      isPublished: false,
      homepagePosition: null,
      indexPosition: null,
      pancakeCategoryIds: [],
    },
  ]);
});

test("collection admin rejects malformed checkbox, homepage position and category CSV before persistence", async () => {
  let saves = 0;
  const service = createCollectionDefinitionAdminService({
    async saveDefinition() {
      saves += 1;
      throw new Error("must not write");
    },
  });

  for (const input of [
    { ...validInput(), isPublished: "yes" },
    { ...validInput(), homepagePosition: "0" },
    { ...validInput(), homepagePosition: "7" },
    { ...validInput(), homepagePosition: "1.5" },
    { ...validInput(), indexPosition: "0" },
    { ...validInput(), indexPosition: "100" },
    { ...validInput(), indexPosition: "1.5" },
    { ...validInput(), indexPosition: "-3" },
    { ...validInput(), pancakeCategoryIds: "7,,42" },
    { ...validInput(), pancakeCategoryIds: "7, 7" },
    { ...validInput(), pancakeCategoryIds: "1.5" },
    { ...validInput(), pancakeCategoryIds: "2147483648" },
  ]) {
    assert.deepEqual(await service.save(adminSession, input), {
      ok: false,
      reason: "INVALID_INPUT",
    });
  }
  assert.equal(saves, 0);
});

test("collection admin collapses domain validation failures to a safe form result", async () => {
  let saves = 0;
  const service = createCollectionDefinitionAdminService({
    async saveDefinition(definition) {
      saves += 1;
      throw new CollectionDefinitionError(
        typeof definition === "object" ? "collection-description" : "collection-shape",
      );
    },
  });

  assert.deepEqual(await service.save(adminSession, validInput()), {
    ok: false,
    reason: "INVALID_INPUT",
  });
  assert.equal(saves, 1);
});

test("collection admin update treats the target as untrusted and never falls back to create", async () => {
  const creates: string[] = [];
  const updates: Array<{ targetSlug: string; title: string }> = [];
  const service = createCollectionDefinitionAdminService(
    {
      async createDefinition(definition: { slug: string }) {
        creates.push(definition.slug);
        return definition;
      },
      async updateExistingDefinition(
        targetSlug: string,
        fields: { title: string },
      ) {
        updates.push({ targetSlug, title: fields.title });
        if (targetSlug === "missing-target") return null;
        return { slug: targetSlug, ...fields };
      },
    } as never,
  );
  const update = Reflect.get(service, "update") as
    | ((session: typeof adminSession, targetSlug: unknown, input: unknown) => Promise<unknown>)
    | undefined;

  assert.equal(typeof update, "function");
  if (!update) return;

  const normal = await update(adminSession, "city-uniform", {
    ...validInput(),
    slug: "forged-visible-slug",
  });
  assert.deepEqual(normal, {
    ok: true,
    definition: {
      slug: "city-uniform",
      title: "City Uniform",
      description: "Daily tailoring and essentials.",
      seoTitle: "City Uniform | LA Clothing",
      seoDescription: "Everyday menswear essentials.",
      isPublished: true,
      homepagePosition: 2,
      indexPosition: null,
      pancakeCategoryIds: [7, 42],
    },
  });
  assert.deepEqual(updates, [{ targetSlug: "city-uniform", title: "City Uniform" }]);

  assert.deepEqual(await update(adminSession, "missing-target", validInput()), {
    ok: false,
    reason: "INVALID_INPUT",
  });
  assert.deepEqual(creates, []);
});

test("collection admin takes an optional /collections index position from 1 through 99", async () => {
  const writes: { indexPosition: number | null }[] = [];
  const service = createCollectionDefinitionAdminService({
    async saveDefinition(definition) {
      writes.push(definition);
      return definition;
    },
  });

  for (const indexPosition of ["1", " 12 ", "99", "", undefined]) {
    assert.equal((await service.save(adminSession, { ...validInput(), indexPosition })).ok, true);
  }
  assert.deepEqual(
    writes.map((definition) => definition.indexPosition),
    [1, 12, 99, null, null],
  );
});
