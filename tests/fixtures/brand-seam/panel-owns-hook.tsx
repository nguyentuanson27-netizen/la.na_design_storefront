/**
 * Negative fixture: a view that owns the hook instead of taking a controller.
 *
 * This is the shape the seam exists to forbid — a page holding one selection cannot hand it to a
 * panel that insists on making its own. It must not satisfy the contract.
 */
import { useVariantSelection } from "@/components/headless/use-variant-selection";
import type { UseVariantSelectionInput } from "@/components/headless/use-variant-selection";

function PanelThatOwnsItsSelection(props: UseVariantSelectionInput) {
  const controller = useVariantSelection(props);
  return controller.view.priceLabel;
}

type ViewProps = Parameters<typeof PanelThatOwnsItsSelection>[0];

const takesAController: "controller" extends keyof ViewProps ? true : never = true;

export const contract = takesAController;
