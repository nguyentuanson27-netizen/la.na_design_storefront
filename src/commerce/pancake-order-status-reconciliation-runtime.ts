import { prisma } from "../db/prisma.ts";
import { createVoucherRedemptionService } from "./voucher-redemption-service.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig, type PancakeConfig } from "../integrations/pancake/config.ts";
import { createPancakeOrderGateway } from "../integrations/pancake/order-gateway.ts";
import {
  createPancakeOrderStatusReconciliationService,
  type PancakeOrderStatusReconcileResult,
} from "./pancake-order-status-reconciliation.ts";

type StatusGateway = Pick<ReturnType<typeof createPancakeOrderGateway>, "fetchOrderStatus">;

type StatusService = Readonly<{
  reconcile(input: { orderId: string }): Promise<PancakeOrderStatusReconcileResult>;
}>;

type RuntimeOptions = Readonly<{
  readConfig?: () => PancakeConfig;
  createGateway?: (config: PancakeConfig) => StatusGateway;
  createService?: (
    gateway: StatusGateway,
    options: Readonly<{ shopId: number }>,
  ) => StatusService;
}>;

function defaultCreateGateway(config: PancakeConfig): StatusGateway {
  return createPancakeOrderGateway(new PancakeClient({ apiKey: config.apiKey }));
}

function defaultCreateService(
  gateway: StatusGateway,
  options: Readonly<{ shopId: number }>,
): StatusService {
  // V14: a verified Pancake cancel refunds the order's voucher once (settle path: no feature flag involved).
  const redemptions = createVoucherRedemptionService(prisma);
  return createPancakeOrderStatusReconciliationService(prisma, gateway, {
    ...options,
    async onTrustedCancel({ orderId }) { await redemptions.refundOrder({ orderId, reason: "POS_CANCELLED" }); },
  });
}

export function createPancakeOrderStatusReconciliationRuntime(options: RuntimeOptions = {}) {
  const readConfig = options.readConfig ?? readPancakeConfig;
  const createGateway = options.createGateway ?? defaultCreateGateway;
  const createService = options.createService ?? defaultCreateService;

  return {
    async reconcile(input: { orderId: string }): Promise<PancakeOrderStatusReconcileResult> {
      let service: StatusService;
      try {
        const config = readConfig();
        const gateway = createGateway(config);
        service = createService(gateway, { shopId: config.shopId });
      } catch {
        return { ok: false, reason: "STATUS_UNAVAILABLE" };
      }

      return service.reconcile(input);
    },
  };
}

export async function reconcilePancakeOrderStatusByOrderId(
  orderId: string,
): Promise<PancakeOrderStatusReconcileResult> {
  return createPancakeOrderStatusReconciliationRuntime().reconcile({ orderId });
}
