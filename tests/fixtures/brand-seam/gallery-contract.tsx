/**
 * The gallery's seam, as a type-level obligation.
 *
 * Two checks, because neither alone is enough and each misses what the other catches.
 *
 * Assignability of the whole input to the props (`ResolvedGalleryInput extends GalleryProps`) is
 * what pins the *value types*: a gallery declaring `selectedVariantId?: number` fails it. But it
 * does not pin the keys, because a props type that simply omits `selectedVariantId` still accepts
 * an object carrying one — extra properties are assignable. A gallery that dropped the whole
 * resolved selection would pass it.
 *
 * Key containment pins the other half. Together they say: every field of the resolved selection is
 * declared, and declared compatibly.
 *
 * Neither is expressed by assigning the component to a function type — parameters are
 * contravariant, so that check accepts a gallery declaring far less than the contract requires.
 */
import { BrandProductGallery } from "@/components/brand/product-gallery";
import type { GalleryModelInput } from "@/components/headless/resolve-gallery-model";

type GalleryProps = Parameters<typeof BrandProductGallery>[0];
type ResolvedGalleryInput = Omit<GalleryModelInput, "manualSelection">;

/** Every field of the resolved selection is declared — `selectedVariantId` above all. */
type MissingFromProps = Exclude<keyof ResolvedGalleryInput, keyof GalleryProps>;
const declaresEveryField: [MissingFromProps] extends [never] ? true : never = true;

/** …and each is declared with a type the resolved selection actually fits. */
const acceptsResolvedSelection: ResolvedGalleryInput extends GalleryProps ? true : never = true;

/** …and the gallery owns its own manual pick rather than taking one it would overwrite. */
const ownsItsManualPick: "manualSelection" extends keyof GalleryProps ? never : true = true;

export const contract = [declaresEveryField, acceptsResolvedSelection, ownsItsManualPick];
