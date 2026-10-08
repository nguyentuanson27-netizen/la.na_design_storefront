import assert from "node:assert/strict";
import test from "node:test";

import { createTryOnIdentityResolvers } from "../../src/commerce/try-on-identity.ts";
import { handleTryOnQuotaGet } from "../../src/commerce/try-on-endpoint.ts";
import { createTryOnRateLimiter } from "../../src/commerce/try-on-rate-limit.ts";

const CLIENT_KEY = "v1:" + "a".repeat(64);
const headers = () => new Headers({ host: "shop.example.test" });

function resolvers({
  session,
  clientKey = CLIENT_KEY,
}: {
  session: () => Promise<string | null | undefined>;
  clientKey?: string | null;
}) {
  return createTryOnIdentityResolvers({ getSessionUserId: session, deriveClientKey: () => clientKey });
}

test("a signed-in shopper is a member for both attempts and display", async () => {
  const { forAttempt, forDisplay } = resolvers({ session: async () => "user_1" });
  assert.deepEqual(await forAttempt(headers()), { kind: "member", key: "user_1" });
  assert.deepEqual(await forDisplay(headers()), { kind: "member", key: "user_1" });
});

test("with no session, both resolvers give the guest keyed by client address", async () => {
  for (const session of [async () => null, async () => undefined]) {
    const { forAttempt, forDisplay } = resolvers({ session });
    assert.deepEqual(await forAttempt(headers()), { kind: "guest", key: CLIENT_KEY });
    assert.deepEqual(await forDisplay(headers()), { kind: "guest", key: CLIENT_KEY });
  }
});

test("a failed session lookup: spending falls back to guest, but display refuses to guess", async () => {
  const { forAttempt, forDisplay } = resolvers({
    session: async () => {
      throw new Error("database down");
    },
  });
  // Cost policy: a fault can only make the limit stricter.
  assert.deepEqual(await forAttempt(headers()), { kind: "guest", key: CLIENT_KEY });
  // Display: a signed-in shopper must not be shown the guest allowance during an auth fault.
  await assert.rejects(() => forDisplay(headers()), /database down/);
});

test("a session whose id cannot be used as a key is never shown as a guest", async () => {
  const { forAttempt, forDisplay } = resolvers({ session: async () => "has spaces/and slashes" });
  assert.deepEqual(await forAttempt(headers()), { kind: "guest", key: CLIENT_KEY });
  assert.equal(await forDisplay(headers()), null);
});

test("with no derivable client address there is no identity, for either", async () => {
  const { forAttempt, forDisplay } = resolvers({ session: async () => null, clientKey: null });
  assert.equal(await forAttempt(headers()), null);
  assert.equal(await forDisplay(headers()), null);
});

test("through the quota endpoint, an auth fault is a bare 503, never the guest allowance", async () => {
  const limiter = createTryOnRateLimiter();
  const { forDisplay } = resolvers({
    session: async () => {
      throw new Error("database down");
    },
  });
  const response = await handleTryOnQuotaGet(new Request("https://shop.example.test/api/try-on"), {
    resolveIdentity: forDisplay,
    peekQuota: limiter.peekQuota,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});

test("through the quota endpoint, a healthy lookup reports the right audience", async () => {
  const limiter = createTryOnRateLimiter();
  const member = resolvers({ session: async () => "user_1" });
  const guest = resolvers({ session: async () => null });
  const ask = async (resolveIdentity: typeof member.forDisplay) =>
    (await handleTryOnQuotaGet(new Request("https://shop.example.test/api/try-on"), {
      resolveIdentity,
      peekQuota: limiter.peekQuota,
    })).json();

  assert.deepEqual(await ask(member.forDisplay), { ok: true, audience: "member", limit: 10, remaining: 10 });
  assert.deepEqual(await ask(guest.forDisplay), { ok: true, audience: "guest", limit: 5, remaining: 5 });
});
