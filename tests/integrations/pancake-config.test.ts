import assert from "node:assert/strict";
import test from "node:test";

import {
  PancakeConfigError,
  readPancakeConfig,
  readPancakeOrderSourceId,
  readPancakeSecondaryShopConfig,
  readPancakeShopId,
} from "../../src/integrations/pancake/config.ts";

test("reads explicit Pancake API key and shop ID from server environment", () => {
  const config = readPancakeConfig({
    PANCAKE_API_KEY: "  secret-key  ",
    PANCAKE_SHOP_ID: "6036602",
  });

  assert.deepEqual(config, {
    apiKey: "secret-key",
    shopId: 6036602,
  });
});

test("reads storefront shop scope without requiring the Pancake API credential", () => {
  assert.equal(readPancakeShopId({ PANCAKE_SHOP_ID: "6036602" }), 6036602);
  assert.throws(() => readPancakeShopId({}), PancakeConfigError);
  assert.throws(() => readPancakeShopId({ PANCAKE_SHOP_ID: "invalid" }), PancakeConfigError);
});

test("fails closed when required Pancake configuration is missing or invalid", async (t) => {
  const cases: Array<{ name: string; env: Record<string, string | undefined> }> = [
    { name: "missing key", env: { PANCAKE_SHOP_ID: "6036602" } },
    { name: "blank key", env: { PANCAKE_API_KEY: " ", PANCAKE_SHOP_ID: "6036602" } },
    { name: "missing shop", env: { PANCAKE_API_KEY: "secret" } },
    { name: "non-numeric shop", env: { PANCAKE_API_KEY: "secret", PANCAKE_SHOP_ID: "abc" } },
    { name: "non-positive shop", env: { PANCAKE_API_KEY: "secret", PANCAKE_SHOP_ID: "0" } },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.throws(() => readPancakeConfig(scenario.env), PancakeConfigError);
    });
  }
});

test("configuration errors never include the API key value", () => {
  const apiKey = "super-sensitive-api-key";

  assert.throws(
    () => readPancakeConfig({ PANCAKE_API_KEY: apiKey, PANCAKE_SHOP_ID: "invalid" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
});

test("reads the optional POS order source ID and fails closed when it is malformed", () => {
  assert.equal(readPancakeOrderSourceId({}), undefined);
  assert.equal(readPancakeOrderSourceId({ PANCAKE_ORDER_SOURCE_ID: "  " }), undefined);
  assert.equal(readPancakeOrderSourceId({ PANCAKE_ORDER_SOURCE_ID: " 922027175 " }), 922027175);
  for (const bad of ["abc", "0", "-1", "1.5", "99999999999999999999"]) {
    assert.throws(
      () => readPancakeOrderSourceId({ PANCAKE_ORDER_SOURCE_ID: bad }),
      PancakeConfigError,
    );
  }
  assert.deepEqual(
    readPancakeConfig({
      PANCAKE_API_KEY: "k",
      PANCAKE_SHOP_ID: "6036602",
      PANCAKE_ORDER_SOURCE_ID: "922027175",
    }),
    { apiKey: "k", shopId: 6036602, orderSourceId: 922027175 },
  );
});

test("reads optional secondary Pancake shop configuration and fails closed when malformed", () => {
  assert.equal(readPancakeSecondaryShopConfig({}), null);
  assert.equal(
    readPancakeSecondaryShopConfig({
      PANCAKE_SECONDARY_SHOP_ID: "  ",
      PANCAKE_SECONDARY_API_KEY: "",
    }),
    null,
  );

  assert.deepEqual(
    readPancakeSecondaryShopConfig({
      PANCAKE_SECONDARY_SHOP_ID: " 407962350 ",
      PANCAKE_SECONDARY_API_KEY: " test-secondary-api-key ",
    }),
    { shopId: 407962350, apiKey: "test-secondary-api-key" },
  );

  // Missing one part
  assert.throws(
    () => readPancakeSecondaryShopConfig({ PANCAKE_SECONDARY_SHOP_ID: "407962350" }),
    PancakeConfigError,
  );
  assert.throws(
    () => readPancakeSecondaryShopConfig({ PANCAKE_SECONDARY_API_KEY: "key" }),
    PancakeConfigError,
  );

  // Malformed shop ID
  for (const bad of ["abc", "0", "-1", "1.5", "99999999999999999999"]) {
    assert.throws(
      () =>
        readPancakeSecondaryShopConfig({
          PANCAKE_SECONDARY_SHOP_ID: bad,
          PANCAKE_SECONDARY_API_KEY: "key",
        }),
      PancakeConfigError,
    );
  }

  // Included in readPancakeConfig
  assert.deepEqual(
    readPancakeConfig({
      PANCAKE_API_KEY: "primary-key",
      PANCAKE_SHOP_ID: "4741464",
      PANCAKE_SECONDARY_SHOP_ID: "407962350",
      PANCAKE_SECONDARY_API_KEY: "sec-key",
    }),
    {
      apiKey: "primary-key",
      shopId: 4741464,
      secondaryShop: {
        apiKey: "sec-key",
        shopId: 407962350,
      },
    },
  );
});

test("refuses a secondary shop that is the primary shop, which would count the same stock twice", () => {
  assert.throws(
    () =>
      readPancakeConfig({
        PANCAKE_API_KEY: "primary-key",
        PANCAKE_SHOP_ID: "4741464",
        PANCAKE_SECONDARY_SHOP_ID: " 4741464 ",
        PANCAKE_SECONDARY_API_KEY: "sec-key",
      }),
    PancakeConfigError,
  );
});
