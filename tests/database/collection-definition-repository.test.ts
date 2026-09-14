import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { CollectionDefinitionError } from "../../src/commerce/collection-definition.ts";
import { createCollectionDefinitionRepository } from "../../src/commerce/collection-definition-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const repository = createCollectionDefinitionRepository(prisma);

async function cleanup() {
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { startsWith: "p7-repo-" } },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("P7 repository validates and upserts one canonical website-owned definition by slug", async () => {
  const initial = await repository.saveDefinition({
    slug: "p7-repo-shirts",
    title: "Shirts",
    description: "Initial collection copy.",
    pancakeCategoryIds: [42, 7, 42],
  });
  const updated = await repository.saveDefinition({
    slug: "p7-repo-shirts",
    title: "Shirts Updated",
    description: "Updated collection copy.",
    seoTitle: "Shirts | LA Clothing",
    isPublished: true,
    pancakeCategoryIds: [7],
  });

  assert.equal(initial.isPublished, false);
  assert.equal(initial.homepagePosition, null);
  assert.deepEqual(initial.pancakeCategoryIds, [7, 42]);
  assert.equal(updated.title, "Shirts Updated");
  assert.equal(updated.isPublished, true);
  assert.equal(updated.homepagePosition, null);
  assert.deepEqual(updated.pancakeCategoryIds, [7]);
  assert.equal(
    await prisma.collectionDefinition.count({ where: { slug: "p7-repo-shirts" } }),
    1,
  );
});

test("P7 create-only persistence never overwrites an existing collection", async () => {
  const created = await repository.createDefinition({
    slug: "p7-repo-create-only",
    title: "Create Only",
    description: "Original copy.",
  });
  assert.equal(created?.title, "Create Only");

  const duplicate = await repository.createDefinition({
    slug: "p7-repo-create-only",
    title: "Forged Replacement",
    description: "Must not overwrite the original row.",
  });
  assert.equal(duplicate, null);

  const persisted = await prisma.collectionDefinition.findUnique({
    where: { slug: "p7-repo-create-only" },
    select: { title: true, description: true },
  });
  assert.deepEqual(persisted, {
    title: "Create Only",
    description: "Original copy.",
  });
});

test("P7 update-existing persistence cannot create a forged or missing collection target", async () => {
  await repository.saveDefinition({
    slug: "p7-repo-existing",
    title: "Existing",
    description: "Existing copy.",
  });

  const updated = await repository.updateExistingDefinition("p7-repo-existing", {
    title: "Existing Updated",
    description: "Updated copy.",
    seoTitle: null,
    seoDescription: null,
    isPublished: false,
    homepagePosition: null,
    pancakeCategoryIds: [],
  });
  assert.equal(updated?.title, "Existing Updated");

  const missing = await repository.updateExistingDefinition("p7-repo-forged", {
    title: "Forged",
    description: "Must never be created by edit.",
    seoTitle: null,
    seoDescription: null,
    isPublished: false,
    homepagePosition: null,
    pancakeCategoryIds: [],
  });
  assert.equal(missing, null);
  assert.equal(
    await prisma.collectionDefinition.count({ where: { slug: "p7-repo-forged" } }),
    0,
  );
});

test("P7 repository rejects malformed definitions before persistence", async () => {
  await assert.rejects(
    () =>
      repository.saveDefinition({
        slug: "P7 Invalid Slug",
        title: "Invalid",
        description: "Should never persist.",
      }),
    (error: unknown) =>
      error instanceof CollectionDefinitionError && error.reason === "collection-slug",
  );

  assert.equal(
    await prisma.collectionDefinition.count({
      where: { title: "Invalid" },
    }),
    0,
  );
});

test("P7 public repository reads expose only published allowlisted definition fields", async () => {
  await repository.saveDefinition({
    slug: "p7-repo-draft",
    title: "Draft",
    description: "Draft copy.",
  });
  await repository.saveDefinition({
    slug: "p7-repo-public-b",
    title: "Public B",
    description: "Public B copy.",
    isPublished: true,
  });
  await repository.saveDefinition({
    slug: "p7-repo-public-a",
    title: "Public A",
    description: "Public A copy.",
    isPublished: true,
    pancakeCategoryIds: [77],
  });

  const published = await repository.listPublished(100);
  assert.deepEqual(
    published.filter(({ slug }) => slug.startsWith("p7-repo-")).map(({ slug }) => slug),
    ["p7-repo-public-a", "p7-repo-public-b"],
  );

  assert.equal(await repository.findPublishedBySlug("p7-repo-draft"), null);

  // An exact shape, not a superset: adding a column to `CollectionDefinition` must not make it
  // public by accident. The editorial media below is public deliberately -- the collection page
  // renders it -- and the values are the defaults a definition that has not been art-directed yet
  // carries, which is what a storefront must handle without a hero, a gallery or a video.
  assert.deepEqual(await repository.findPublishedBySlug("p7-repo-public-a"), {
    slug: "p7-repo-public-a",
    title: "Public A",
    description: "Public A copy.",
    seoTitle: null,
    seoDescription: null,
    heroImageUrl: null,
    galleryImageUrls: [],
    videoSrcUrl: null,
    videoPosterUrl: null,
    featuredProductSlugs: [],
  });
});

// `CollectionDefinition.homepagePosition` is globally unique, so slots are a shared resource
// between database test files running in parallel. This file owns 2, 3 and 5;
// `collection-definition-schema.test.ts` owns 1 and 6.
test("U2 homepage merchandising uses explicit positions, ignores slug order, and fails closed on duplicate slots", async () => {
  await repository.saveDefinition({
    slug: "p7-repo-homepage-a",
    title: "Position Five",
    description: "Homepage position five.",
    isPublished: true,
    homepagePosition: 5,
  });
  await repository.saveDefinition({
    slug: "p7-repo-homepage-z",
    title: "Position Two",
    description: "Homepage position two.",
    isPublished: true,
    homepagePosition: 2,
  });
  await repository.saveDefinition({
    slug: "p7-repo-homepage-unpositioned",
    title: "Unpositioned",
    description: "Published but not selected for homepage.",
    isPublished: true,
  });
  await repository.saveDefinition({
    slug: "p7-repo-homepage-draft",
    title: "Draft Position Three",
    description: "Draft must not render on homepage.",
    isPublished: false,
    homepagePosition: 3,
  });

  const homepage = await repository.listHomepageMerchandising();
  assert.deepEqual(
    homepage.filter(({ slug }) => slug.startsWith("p7-repo-homepage-")).map(({ slug }) => slug),
    ["p7-repo-homepage-z", "p7-repo-homepage-a"],
  );

  await assert.rejects(
    () =>
      repository.saveDefinition({
        slug: "p7-repo-homepage-duplicate",
        title: "Duplicate Position",
        description: "Must fail closed.",
        isPublished: true,
        homepagePosition: 2,
      }),
    (error: unknown) =>
      error instanceof CollectionDefinitionError &&
      error.reason === "collection-homepage-position",
  );
});

test("P7 membership resolver returns deterministic canonical slugs and fails closed for stale membership", async () => {
  await repository.saveDefinition({
    slug: "p7-repo-membership-b",
    title: "Membership B",
    description: "Draft membership B.",
  });
  await repository.saveDefinition({
    slug: "p7-repo-membership-a",
    title: "Membership A",
    description: "Draft membership A.",
  });

  assert.deepEqual(
    await repository.resolveMembershipSlugs([
      "p7-repo-membership-b",
      "p7-repo-membership-a",
    ]),
    ["p7-repo-membership-a", "p7-repo-membership-b"],
  );
  assert.equal(
    await repository.resolveMembershipSlugs([
      "p7-repo-membership-a",
      "p7-repo-membership-missing",
    ]),
    null,
  );
  assert.deepEqual(await repository.resolveMembershipSlugs([]), []);
});

test("P7 repository bounds collection list reads", async () => {
  await assert.rejects(() => repository.listPublished(0), RangeError);
  await assert.rejects(() => repository.listForAdmin(101), RangeError);
});
