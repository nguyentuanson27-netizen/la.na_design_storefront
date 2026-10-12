import { requireAdminSession } from "../auth/authorization.ts";
import { MerchandisingError, parseOrderedProductSelection } from "./merchandising-input.ts";
import { parseNewArrivalOperation } from "./new-arrivals-selection.ts";

type AdminSessionCandidate =
  | { user: { id: string; role?: string | null }; session: { id: string } }
  | null
  | undefined;

type NewArrivalWriter = {
  applyChange(input: { shopId: number; operation: unknown; productId: unknown }): Promise<unknown>;
};

export function createNewArrivalsAdminService({
  shopId,
  repository,
}: {
  shopId: number;
  repository: NewArrivalWriter;
}) {
  return {
    async update(session: AdminSessionCandidate, input: unknown) {
      requireAdminSession(session);
      try {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new MerchandisingError("merchandising-shape");
        }
        const values = input as Record<string, unknown>;
        const operation = parseNewArrivalOperation(values.operation);
        const [productId] = parseOrderedProductSelection([values.productId], { max: 1 });
        await repository.applyChange({ shopId, operation, productId });
        return { ok: true } as const;
      } catch (error) {
        if (error instanceof MerchandisingError) {
          return { ok: false, reason: error.reason } as const;
        }
        throw error;
      }
    },
  };
}
