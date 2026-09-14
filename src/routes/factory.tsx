import type { ReactNode } from "react";
import type { Metadata } from "next";

import { StorefrontRoute, type RouteHandle } from "./core.tsx";

/**
 * Joins a loader to its markup, so a page module is left with wiring rather than decisions.
 *
 * The two overloads exist because Next refuses a route segment that exports both `metadata` and
 * `generateMetadata`. Metadata declared on the page is therefore a different shape of module from
 * metadata declared in a layout or as a static const -- and the factory returns exactly the exports
 * that shape is allowed to have, instead of returning both and trusting each page to re-export the
 * right one.
 *
 * There is deliberately no `metadataMode` parameter. `layout` and `static` produce identical
 * behaviour here, so a mode argument would be a label the factory never reads; where the metadata
 * lives is the manifest's business, and the verifier reads it from there.
 */

type RouteDefinition<P, D> = Readonly<{
  load: (props: P) => Promise<RouteHandle<D>>;
  render: (data: D) => ReactNode;
}>;

/** Metadata lives on the page: the factory supplies `generateMetadata` alongside `Page`. */
export function createStorefrontRoute<P, D>(
  definition: RouteDefinition<P, D> & Readonly<{ metadata: (props: P) => Promise<Metadata> }>,
): {
  Page: (props: P) => Promise<ReactNode>;
  generateMetadata: (props: P) => Promise<Metadata>;
};

/** Metadata lives in the layout, or is a static const: the factory supplies only `Page`. */
export function createStorefrontRoute<P, D>(
  definition: RouteDefinition<P, D>,
): { Page: (props: P) => Promise<ReactNode> };

export function createStorefrontRoute<P, D>(
  definition: RouteDefinition<P, D> & Readonly<{ metadata?: (props: P) => Promise<Metadata> }>,
): {
  Page: (props: P) => Promise<ReactNode>;
  generateMetadata?: (props: P) => Promise<Metadata>;
} {
  const Page = async (props: P): Promise<ReactNode> => {
    const handle = await definition.load(props);
    // The only construction of the shell. A page receives its data through the render prop, so
    // there is no arrangement in which markup renders and the shell's concerns do not.
    return <StorefrontRoute<D> handle={handle}>{definition.render}</StorefrontRoute>;
  };

  if (definition.metadata === undefined) return { Page };

  const metadata = definition.metadata;
  return { Page, generateMetadata: (props: P) => metadata(props) };
}
