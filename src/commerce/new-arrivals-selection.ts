import { MerchandisingError, parseOrderedProductSelection } from "./merchandising-input.ts";

/** An operational admin bound, not a rolling recency or expiration window. */
export const MAX_NEW_ARRIVAL_PRODUCTS = 500;
export const NEW_ARRIVALS_PAGE_SIZE = 24;
export type NewArrivalOperation = "add" | "remove" | "move-up" | "move-down";

export function parseNewArrivalOperation(value: unknown): NewArrivalOperation {
  if (
    value === "add" ||
    value === "remove" ||
    value === "move-up" ||
    value === "move-down"
  ) return value;
  throw new MerchandisingError("merchandising-shape");
}

/** The only ordering rule: admin-selected IDs, never ProductMirror.createdAt. */
export function applyNewArrivalChange(
  current: readonly string[],
  operationInput: unknown,
  productIdInput: unknown,
): readonly string[] {
  const operation = parseNewArrivalOperation(operationInput);
  const [productId] = parseOrderedProductSelection([productIdInput], { max: 1 });
  const index = current.indexOf(productId!);

  if (operation === "add") {
    if (index !== -1) return [...current];
    if (current.length >= MAX_NEW_ARRIVAL_PRODUCTS) {
      throw new MerchandisingError("merchandising-too-many");
    }
    return [...current, productId!];
  }

  // A stale or forged row action must not silently manipulate a different selection.
  if (index === -1) throw new MerchandisingError("merchandising-invalid-product");
  if (operation === "remove") return current.filter((id) => id !== productId);

  const swapWith = operation === "move-up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= current.length) return [...current];
  const next = [...current];
  [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
  return next;
}
