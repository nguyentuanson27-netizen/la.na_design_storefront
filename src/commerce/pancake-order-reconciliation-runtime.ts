import { prisma } from "../db/prisma.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import type { PancakeConfig } from "../integrations/pancake/config.ts";
import { createPancakeOrderGateway } from "../integrations/pancake/order-gateway.ts";
import {
  createPancakeOrderReconciliationService,
  type OrderReconciliationResult,
} from "./pancake-order-reconciliation.ts";

type ReconciliationGateway = Pick<
  ReturnType<typeof createPancakeOrderGateway>,
  "searchOrderByMarker"
>;

type ReconciliationService = Readonly<{
  reconcileOrder(publicCode: string): Promise<OrderReconciliationResult>;
}>;

export type PancakeOrderReconciliationRuntimeEvent = Readonly<{
  name: "pancake_order.reconciliation";
  publicCode: string;
  ok: boolean;
  state: string | null;
  reason: string | null;
}>;

type RuntimeOptions = Readonly<{
  createGateway?: (config: PancakeConfig) => ReconciliationGateway;
  createService?: (gateway: ReconciliationGateway) => ReconciliationService;
  findUnknownOrder?: (
    cartId: string,
    shopId: number,
  ) => Promise<{ publicCode: string } | null>;
  onEvent?: (event: PancakeOrderReconciliationRuntimeEvent) => void;
}>;

function defaultCreateGateway(config: PancakeConfig): ReconciliationGateway {
  return createPancakeOrderGateway(new PancakeClient({ apiKey: config.apiKey }));
}

function defaultCreateService(gateway: ReconciliationGateway): ReconciliationService {
  return createPancakeOrderReconciliationService({
    client: prisma,
    gateway,
  });
}

async function defaultFindUnknownOrder(
  cartId: string,
  shopId: number,
): Promise<{ publicCode: string } | null> {
  return prisma.orderMirror.findFirst({
    where: {
      sourceCartId: cartId,
      pancakeShopId: shopId,
      state: "SYNC_UNKNOWN",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { publicCode: true },
  });
}

function writeReconciliationEvent(event: PancakeOrderReconciliationRuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createPancakeOrderReconciliationRuntime(
  config: PancakeConfig,
  options: RuntimeOptions = {},
) {
  const gateway = (options.createGateway ?? defaultCreateGateway)(config);
  const service = (options.createService ?? defaultCreateService)(gateway);
  const findUnknownOrder = options.findUnknownOrder ?? defaultFindUnknownOrder;
  const onEvent = options.onEvent ?? writeReconciliationEvent;

  return {
    async reconcileCart(cartId: string): Promise<OrderReconciliationResult | null> {
      const order = await findUnknownOrder(cartId, config.shopId);
      if (!order) return null;

      const result = await service.reconcileOrder(order.publicCode);
      onEvent({
        name: "pancake_order.reconciliation",
        publicCode: order.publicCode,
        ok: result.ok,
        state: result.state ?? null,
        reason: result.ok ? null : result.reason,
      });
      return result;
    },
  };
}
