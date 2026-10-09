import assert from "node:assert/strict";
import test from "node:test";

import { warmFlowWorker } from "../../src/integrations/google-flow-try-on/warm.ts";

const config = {
  available: true,
  provider: "flow",
  workerUrl: "http://flow-worker:8787",
  workerToken: "t".repeat(64),
} as const;

test("warm posts to the worker's warm endpoint with the bearer token and no body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  warmFlowWorker({
    config,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, state: "starting" }));
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://flow-worker:8787/v1/warm");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.equal(calls[0]!.init.body, undefined);
  assert.deepEqual(calls[0]!.init.headers, { authorization: `Bearer ${config.workerToken}` });
  assert.ok(calls[0]!.init.signal);
});

test("warm never throws or rejects, whether the worker is down or fetch itself fails", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    warmFlowWorker({
      config,
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    });
    assert.doesNotThrow(() =>
      warmFlowWorker({
        config,
        fetch: () => {
          throw new Error("synchronous failure");
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
