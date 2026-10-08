export type PancakeConfig = {
  apiKey: string;
  shopId: number;
  /** Pancake POS order source ID (`PANCAKE_ORDER_SOURCE_ID`); absent when not configured. */
  orderSourceId?: number;
};

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export class PancakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PancakeConfigError";
  }
}

export function readPancakeShopId(env: ServerEnvironment = process.env): number {
  const shopIdInput = env.PANCAKE_SHOP_ID?.trim();
  if (!shopIdInput || !/^\d+$/.test(shopIdInput)) {
    throw new PancakeConfigError("PANCAKE_SHOP_ID must be a positive integer");
  }

  const shopId = Number(shopIdInput);
  if (!Number.isSafeInteger(shopId) || shopId <= 0) {
    throw new PancakeConfigError("PANCAKE_SHOP_ID must be a positive integer");
  }

  return shopId;
}

/**
 * The optional POS order source ("Nguồn đơn") that tags storefront orders. Unset or blank means
 * orders are created without a source; a set but malformed value fails closed rather than silently
 * dropping the tag.
 */
export function readPancakeOrderSourceId(env: ServerEnvironment = process.env): number | undefined {
  const input = env.PANCAKE_ORDER_SOURCE_ID?.trim();
  if (!input) return undefined;
  const id = /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PancakeConfigError("PANCAKE_ORDER_SOURCE_ID must be a positive integer when set");
  }
  return id;
}

export function readPancakeConfig(env: ServerEnvironment = process.env): PancakeConfig {
  const apiKey = env.PANCAKE_API_KEY?.trim();
  if (!apiKey) {
    throw new PancakeConfigError("PANCAKE_API_KEY must be configured on the server");
  }

  const orderSourceId = readPancakeOrderSourceId(env);
  return {
    apiKey,
    shopId: readPancakeShopId(env),
    ...(orderSourceId === undefined ? {} : { orderSourceId }),
  };
}
