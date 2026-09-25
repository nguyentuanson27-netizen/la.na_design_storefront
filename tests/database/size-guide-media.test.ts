import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createSizeGuideMediaRepository } from "../../src/commerce/size-guide-media.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createSizeGuideMediaRepository(prisma);
const IMAGE = "https://content.pancake.vn/2-2609/2026/9/24/bang-size-ao-dai.webp";
const REPLACEMENT = "https://content.pancake.vn/2-2609/2026/9/25/bang-size-ao-dai-2.jpg";

async function cleanup() {
  await prisma.sizeGuideMedia.deleteMany({ where: { guideId: "ao-dai" } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("size-guide artwork is saved, replaced and cleared per guide", async () => {
  assert.equal(await repository.readImageUrl("ao-dai"), null);

  await repository.save({ guideId: "ao-dai", imageUrl: IMAGE });
  assert.equal(await repository.readImageUrl("ao-dai"), IMAGE);
  assert.equal((await repository.listImageUrls()).get("ao-dai"), IMAGE);

  await repository.save({ guideId: "ao-dai", imageUrl: REPLACEMENT });
  assert.equal(await repository.readImageUrl("ao-dai"), REPLACEMENT);

  await repository.save({ guideId: "ao-dai", imageUrl: "" });
  assert.equal(await repository.readImageUrl("ao-dai"), null);
  assert.equal((await repository.listImageUrls()).has("ao-dai"), false);
});

test("an untrusted link leaves the saved artwork untouched", async () => {
  await repository.save({ guideId: "ao-dai", imageUrl: IMAGE });
  await assert.rejects(repository.save({ guideId: "ao-dai", imageUrl: "https://example.com/a/b/c/d/e.webp" }));
  assert.equal(await repository.readImageUrl("ao-dai"), IMAGE);
});
