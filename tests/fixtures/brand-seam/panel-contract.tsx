/**
 * The purchase panel's seam, as a type-level obligation.
 *
 * A brand rewrites `purchase-panel.tsx` freely, so the contract cannot be a pattern its source has
 * to match. What must hold is behavioural: the view accepts a controller someone else owns (or a
 * page cannot drive panel and gallery from one selection), and the standalone panel still accepts
 * the hook's input.
 *
 * Compare object types directly instead of assigning the component to a function type: function
 * parameters are contravariant, so component assignment can accept a view that declares less than
 * the contract requires.
 *
 * The standalone panel needs both checks for the same reason the gallery does: assignability pins
 * the value types, key containment pins that the fields are declared at all. A panel that omitted
 * `options` would still accept an object carrying one, so assignability alone would pass it.
 */
import { BrandPurchasePanel, PurchasePanelView } from "@/components/brand/purchase-panel";
import type {
  UseVariantSelectionInput,
  VariantSelectionController,
} from "@/components/headless/use-variant-selection";

type ViewProps = Parameters<typeof PurchasePanelView>[0];
type StandaloneProps = Parameters<typeof BrandPurchasePanel>[0];

/** The view must take a controller it does not own… */
const takesAController: "controller" extends keyof ViewProps ? true : never = true;

/** …and an externally owned hook controller must be assignable to that prop. */
const takesTheHooksController: VariantSelectionController extends ViewProps["controller"]
  ? true
  : never = true;

/** The standalone panel must declare every field of the hook's input… */
type MissingFromStandalone = Exclude<keyof UseVariantSelectionInput, keyof StandaloneProps>;
const declaresHookInput: [MissingFromStandalone] extends [never] ? true : never = true;

/** …and declare them compatibly. */
const acceptsHookInput: UseVariantSelectionInput extends StandaloneProps ? true : never = true;

export const contract = [
  takesAController,
  takesTheHooksController,
  declaresHookInput,
  acceptsHookInput,
];
