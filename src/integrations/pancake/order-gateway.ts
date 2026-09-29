import type { PancakeCatalogVariation } from "./catalog-contract.ts";
import { fetchAllPancakeCatalogVariations } from "./catalog-pages.ts";
import {
  fetchPancakeVariationsByIds,
  MAX_VARIATIONS_PER_READ,
  PancakeVariationFilterMismatchError,
} from "./variation-stock-read.ts";
import type { PancakeCreateOrderRequest } from "./order-create.ts";
import {
  searchOrderByMarker,
  sanitizeSecrets,
  type MarkerSearchResult,
  type OrderSearchOptions,
} from "./order-search.ts";
import {
  isCanonicalPancakeOrderId,
  parsePancakeOrderStatusResponse,
  type PancakeOrderStatus,
} from "./order-status.ts";

type QueryValue = string | number | boolean | readonly string[];
type PostJsonOptions = Readonly<{ expectedStatus?: number | readonly number[] }>;

export type PancakeOrderGatewayClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
  postJson(endpoint: string, body: unknown, options?: PostJsonOptions): Promise<unknown>;
  putJson?(endpoint: string, body: unknown, options?: PostJsonOptions): Promise<unknown>;
};

type FetchCompleteCatalog = (input: {
  client: PancakeOrderGatewayClient;
  shopId: number;
}) => Promise<readonly PancakeCatalogVariation[]>;

type FetchVariationsByIds = (input: {
  client: PancakeOrderGatewayClient;
  shopId: number;
  variationIds: readonly string[];
}) => Promise<readonly PancakeCatalogVariation[]>;

function requireShopId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Pancake shop id must be a positive safe integer");
  }
  return value;
}

function requireOrderId(value: string): string {
  if (!isCanonicalPancakeOrderId(value)) {
    throw new TypeError("Pancake order id must be a canonical positive safe integer string");
  }
  return value;
}

export function createPancakeOrderGateway(
  client: PancakeOrderGatewayClient,
  fetchCompleteCatalog: FetchCompleteCatalog = fetchAllPancakeCatalogVariations,
  fetchVariationsByIds: FetchVariationsByIds = fetchPancakeVariationsByIds,
) {
  return {
    async fetchCompleteCatalog(shopId: number): Promise<readonly PancakeCatalogVariation[]> {
      return fetchCompleteCatalog({ client, shopId: requireShopId(shopId) });
    },

    /**
     * The live rows for just the variations an order touches — what checkout needs to re-price and
     * re-check stock. Paging the full catalog for a two-line order costs one sequential request per
     * hundred variations in the shop, all of it while the buyer waits on "Đang đặt hàng…"; this is
     * one request per hundred *requested* ids, issued together.
     *
     * A requested id Pancake does not return is simply absent, exactly as it would be absent from a
     * full traversal. If Pancake ever stops honouring the `variation_ids[]` filter the targeted read
     * fails closed, and this falls back to the full traversal rather than failing every checkout.
     */
    async fetchVariations(
      shopId: number,
      variationIds: readonly string[],
    ): Promise<readonly PancakeCatalogVariation[]> {
      const checkedShopId = requireShopId(shopId);
      const requested = [...new Set(variationIds)];
      if (requested.length === 0) return [];

      const chunks: string[][] = [];
      for (let start = 0; start < requested.length; start += MAX_VARIATIONS_PER_READ) {
        chunks.push(requested.slice(start, start + MAX_VARIATIONS_PER_READ));
      }
      try {
        const pages = await Promise.all(
          chunks.map((chunk) =>
            fetchVariationsByIds({ client, shopId: checkedShopId, variationIds: chunk }),
          ),
        );
        return pages.flat();
      } catch (error) {
        if (!(error instanceof PancakeVariationFilterMismatchError)) throw error;
      }
      const wanted = new Set(requested);
      const catalog = await fetchCompleteCatalog({ client, shopId: checkedShopId });
      return catalog.filter((variation) => wanted.has(variation.id));
    },

    async fetchOrderStatus(shopId: number, orderId: string): Promise<PancakeOrderStatus> {
      const checkedShopId = requireShopId(shopId);
      const checkedOrderId = requireOrderId(orderId);
      const payload = await client.getJson(`/shops/${checkedShopId}/orders/${checkedOrderId}`);
      return parsePancakeOrderStatusResponse(payload, {
        shopId: checkedShopId,
        orderId: checkedOrderId,
      });
    },

    async createOrder(request: PancakeCreateOrderRequest): Promise<unknown> {
      const shopId = requireShopId(request.shop_id);
      return client.postJson(`/shops/${shopId}/orders`, request, { expectedStatus: [200, 201] });
    },

    async searchOrderByMarker(
      shopId: number,
      marker: string,
      options?: OrderSearchOptions,
    ): Promise<MarkerSearchResult> {
      return searchOrderByMarker(client, requireShopId(shopId), marker, options);
    },

    async cancelOrder(shopId: number, orderId: string): Promise<void> {
      const checkedShopId = requireShopId(shopId);
      const checkedOrderId = requireOrderId(orderId);
      let mutateError: unknown;
      try {
        if (typeof client.putJson === "function") {
          await client.putJson(`/shops/${checkedShopId}/orders/${checkedOrderId}`, { status: 7 });
        } else {
          await client.postJson(`/shops/${checkedShopId}/orders/${checkedOrderId}`, { status: 7 });
        }
      } catch (error) {
        mutateError = error;
      }

      try {
        const orderStatus = await this.fetchOrderStatus(checkedShopId, checkedOrderId);
        if (orderStatus.status === 7) return;
        const mutateContext = mutateError
          ? ` after ambiguous cancellation error: ${sanitizeSecrets(mutateError instanceof Error ? mutateError.message : String(mutateError))}`
          : "";
        throw new Error(
          `Order ${checkedOrderId} cancellation readback expected status 7, observed ${orderStatus.status}${mutateContext}`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("cancellation readback expected status 7")) {
          throw error;
        }
        const mutateContext = mutateError
          ? `; cancellation error was ${sanitizeSecrets(mutateError instanceof Error ? mutateError.message : String(mutateError))}`
          : "";
        throw new Error(
          `Order ${checkedOrderId} cancellation readback failed: ${sanitizeSecrets(error instanceof Error ? error.message : String(error))}${mutateContext}`,
        );
      }
    },
  };
}

