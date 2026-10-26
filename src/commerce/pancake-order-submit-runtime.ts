import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { scheduleMetaPurchaseSafely } from "./meta-request-context.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig, type PancakeConfig } from "../integrations/pancake/config.ts";
import { createPancakeOrderGateway } from "../integrations/pancake/order-gateway.ts";
import { createVoucherOrderAcceptance } from "./voucher-order-acceptance.ts";
import {
  createPancakeOrderSubmissionService,
  type PancakeOrderSubmissionEvent,
} from "./pancake-order-submit.ts";

function writePancakeOrderSubmissionEvent(event: PancakeOrderSubmissionEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createPancakeOrderSubmissionRuntime(config: PancakeConfig) {
  const client = new PancakeClient({ apiKey: config.apiKey });
  const gateway = createPancakeOrderGateway(client);
  // V13: voucher acceptance runs in the write-boundary transaction. It is a settle path, so it never reads the
  // feature flag or the verified-shop list; an order with no bound hold passes through without writing.
  const voucherAcceptance = createVoucherOrderAcceptance({ readAttemptSecret: () => readAuthServerConfig().secret });
  return createPancakeOrderSubmissionService(prisma, gateway, {
    onEvent: writePancakeOrderSubmissionEvent,
    orderSourceId: config.orderSourceId,
    async acceptAtWriteBoundary(tx, order) { return (await voucherAcceptance.acceptWithin(tx, { orderId: order.id })).ok; },
    async onConfirmed(code) { await scheduleMetaPurchaseSafely(prisma, code); },
  });
}

export async function submitPancakeOrderByPublicCode(publicCode: string) {
  const config = readPancakeConfig();
  return createPancakeOrderSubmissionRuntime(config).submit({
    publicCode,
    shopId: config.shopId,
  });
}
