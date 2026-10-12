import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../src/auth/authorization.ts";
import { createNewArrivalsAdminService } from "../../src/commerce/new-arrivals-admin.ts";

const ADMIN = { user: { id: "a", role: "ADMIN" }, session: { id: "s" } };
const EDITOR = { user: { id: "e", role: "EDITOR" }, session: { id: "s2" } };

test("only an administrator can change new arrivals", async () => {
  const writes: unknown[] = [];
  const service = createNewArrivalsAdminService({
    shopId: 17,
    repository: { applyChange: async (input) => { writes.push(input); } },
  });

  await assert.rejects(() => service.update(null, { operation: "add", productId: "p" }), AuthorizationError);
  await assert.rejects(
    () => service.update(EDITOR, { operation: "add", productId: "p" }),
    (error: unknown) => error instanceof AuthorizationError && error.code === "FORBIDDEN",
  );
  assert.deepEqual(writes, []);

  assert.deepEqual(await service.update(ADMIN, { operation: "add", productId: "p" }), { ok: true });
  assert.deepEqual(writes, [{ shopId: 17, operation: "add", productId: "p" }]);
});

test("malformed admin submissions fail closed without repository writes", async () => {
  const writes: unknown[] = [];
  const service = createNewArrivalsAdminService({
    shopId: 17,
    repository: { applyChange: async (input) => { writes.push(input); } },
  });
  for (const input of [null, {}, { operation: "add", productId: "" }, { operation: "delete-all", productId: "p" }]) {
    assert.deepEqual((await service.update(ADMIN, input)).ok, false);
  }
  assert.deepEqual(writes, []);
});
