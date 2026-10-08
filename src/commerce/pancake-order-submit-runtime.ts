import { prisma } from "../db/prisma.ts";
import { scheduleMetaPurchaseSafely } from "./meta-request-context.ts";
import { PancakeClient } from "../integrations/pancake/client.ts";
import { readPancakeConfig, type PancakeConfig } from "../integrations/pancake/config.ts";
import { createPancakeOrderGateway } from "../integrations/pancake/order-gateway.ts";
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
  return createPancakeOrderSubmissionService(prisma, gateway, {
    onEvent: writePancakeOrderSubmissionEvent,
    orderSourceId: config.orderSourceId,
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
