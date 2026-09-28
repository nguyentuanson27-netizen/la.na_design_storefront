import { prisma } from "@/db/prisma";
import {
  createInventorySignalRepository,
  handlePancakeInventoryWebhook,
} from "@/commerce/pancake-inventory-signals";

/**
 * Pancake `variations_warehouses` webhook receiver. Authenticated by the custom
 * `x-pancake-webhook-secret` header configured on the Pancake webhook, compared with
 * `PANCAKE_WEBHOOK_SECRET`. It only records (variation, warehouse) markers; the catalog-sync
 * service's 30-second batch reads the authoritative stock from Pancake and applies it.
 */
export async function POST(request: Request) {
  const signals = createInventorySignalRepository(prisma);
  return handlePancakeInventoryWebhook(request, {
    secret: process.env.PANCAKE_WEBHOOK_SECRET,
    record: signals.record,
  });
}
