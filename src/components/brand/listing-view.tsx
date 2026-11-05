"use client";

import Image, { type ImageProps } from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_LISTING_VIEW,
  LISTING_VIEWS,
  LISTING_VIEW_LABELS,
  DEFAULT_PRODUCT_IMAGE_SIZES,
  collectionGridClassName,
  collectionImageSizes,
  parseListingView,
  productGridClassName,
  productImageSizes,
  serializeListingViewCookie,
  withListingViewParam,
  type ListingView,
} from "@/components/headless/listing-view-model";

/**
 * The shopper's chosen photograph size ("kiểu xem"), shared by every listing on the site.
 *
 * The server decides the first paint (`?view=` over the cookie, resolved by the proxy and handed
 * to the provider through the site chrome), so a returning shopper never sees the default flash
 * into their choice. After that the choice lives here: picking a step redraws the grids in place
 * -- no navigation, so a half-scrolled infinite list keeps its place -- and writes both places the
 * server reads it from, the cookie and the URL.
 *
 * The provider lives in the root layout, which Next keeps mounted across client navigations, so
 * `initialView` is only the first paint's answer. A later navigation to a URL that names a
 * different `?view=` (a link, back, forward) reaches the state through `ListingViewUrlSync`.
 */

type ListingViewContextValue = Readonly<{
  view: ListingView;
  setView: (view: ListingView) => void;
  /** The URL named this view: adopt it without writing the URL or cookie back. */
  adoptUrlView: (view: ListingView) => void;
}>;

const ListingViewContext = createContext<ListingViewContextValue>({
  view: DEFAULT_LISTING_VIEW,
  setView: () => {},
  adoptUrlView: () => {},
});

/**
 * The view the enclosing `ListingProductGrid` is drawing, or `null` outside one. The homepage and
 * the product page reuse the product card in grids of their own that the choice does not touch, so
 * the card's image `sizes` follow the view only where a listing grid says they should.
 */
const ListingGridViewContext = createContext<ListingView | null>(null);

export function ListingViewProvider({
  initialView,
  children,
}: Readonly<{ initialView: ListingView; children: ReactNode }>) {
  const [view, setViewState] = useState<ListingView>(initialView);

  const setView = useCallback((next: ListingView) => {
    setViewState(next);
    try {
      document.cookie = serializeListingViewCookie(next, { secure: window.location.protocol === "https:" });
    } catch {
      // Cookies blocked: the choice still holds for this page and the URL below.
    }
    try {
      const { pathname, search, hash } = window.location;
      // `replaceState` is integrated with the router: it changes the address without a server
      // round trip, and keeps the entry Next stored so back/forward still work.
      window.history.replaceState(window.history.state, "", `${pathname}${withListingViewParam(search, next)}${hash}`);
    } catch {
      // Not worth failing a view switch over a locked-down history API.
    }
  }, []);

  const adoptUrlView = useCallback((next: ListingView) => setViewState(next), []);

  const value = useMemo(() => ({ view, setView, adoptUrlView }), [view, setView, adoptUrlView]);
  return (
    <ListingViewContext.Provider value={value}>
      {/* `useSearchParams` needs a boundary; the bridge renders nothing, so the fallback is none. */}
      <Suspense fallback={null}>
        <ListingViewUrlSync />
      </Suspense>
      {children}
    </ListingViewContext.Provider>
  );
}

/**
 * Keeps the state in step with a `?view=` that arrives by navigation. It acts only when the URL
 * names a valid view: a URL without one says nothing, and the cookie's choice (already the state)
 * stands. Picking a view writes the URL itself, so the value seen here then equals the state and
 * nothing changes.
 */
function ListingViewUrlSync() {
  const searchParams = useSearchParams();
  const { adoptUrlView } = useListingView();
  const urlView = parseListingView(searchParams.get("view"));

  useEffect(() => {
    if (urlView !== null) adoptUrlView(urlView);
  }, [urlView, adoptUrlView]);

  return null;
}

export function useListingView(): ListingViewContextValue {
  return useContext(ListingViewContext);
}

/** The product grid. Its columns follow the chosen view; `data-view` lets the card trim its text. */
export function ListingProductGrid({ children }: Readonly<{ children: ReactNode }>) {
  const { view } = useListingView();
  return (
    <ListingGridViewContext.Provider value={view}>
      <div data-view={view} className={`listing-product-grid ${productGridClassName(view)}`}>
        {children}
      </div>
    </ListingGridViewContext.Provider>
  );
}

/**
 * A product card's photograph. It is `next/image` with one difference: inside a listing grid its
 * `sizes` follow the grid's columns, so a card that is a quarter of the screen is not fetched at
 * half-screen width. Outside one it asks for what it always did.
 */
export function ListingCardImage(props: Omit<ImageProps, "sizes">) {
  const gridView = useContext(ListingGridViewContext);
  const sizes = gridView === null ? DEFAULT_PRODUCT_IMAGE_SIZES : productImageSizes(gridView);
  // eslint-disable-next-line jsx-a11y/alt-text -- `alt` arrives in props, which may deliberately be "".
  return <Image {...props} sizes={sizes} />;
}

/** A collection cover's photograph, sized for the columns the chosen view draws. */
export function ListingCollectionImage(props: Omit<ImageProps, "sizes">) {
  const { view } = useListingView();
  // eslint-disable-next-line jsx-a11y/alt-text -- `alt` arrives in props, which may deliberately be "".
  return <Image {...props} sizes={collectionImageSizes(view)} />;
}

/**
 * The collections index's grid. Extra classes (the phone's edge-to-edge bleed and the gaps) come
 * from the page; the columns come from the chosen view.
 */
export function ListingCollectionGrid({
  className = "",
  children,
}: Readonly<{ className?: string; children: ReactNode }>) {
  const { view } = useListingView();
  return (
    <div data-view={view} className={`group/cgrid ${collectionGridClassName(view)} ${className}`}>
      {children}
    </div>
  );
}

/** Two rows of squares, as many columns as the step draws on a phone. */
function ViewGlyph({ columns }: Readonly<{ columns: number }>) {
  const total = 18;
  const gap = 1.5;
  const width = (total - gap * (columns - 1)) / columns;
  const height = (total - gap) / 2;
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width="18" height="18" fill="currentColor" aria-hidden="true">
      {Array.from({ length: columns * 2 }, (_, index) => (
        <rect
          key={index}
          x={(index % columns) * (width + gap)}
          y={Math.floor(index / columns) * (height + gap)}
          width={width}
          height={height}
          rx="0.5"
        />
      ))}
    </svg>
  );
}

const GLYPH_COLUMNS: Readonly<Record<ListingView, number>> = { large: 2, medium: 3, small: 4 };

/**
 * Three buttons -- ảnh lớn, ảnh trung bình, ảnh nhỏ -- that sit beside the result count and sort
 * on every listing. Native buttons with `aria-pressed`, so the current step is announced and the
 * keyboard needs nothing extra.
 */
export function ListingViewToggle({ className = "" }: Readonly<{ className?: string }>) {
  const { view, setView } = useListingView();
  return (
    <div role="group" aria-label="Kiểu xem ảnh" className={`inline-flex items-center gap-1 ${className}`}>
      {LISTING_VIEWS.map((option) => {
        const active = option === view;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            aria-label={LISTING_VIEW_LABELS[option]}
            title={LISTING_VIEW_LABELS[option]}
            data-listing-view-option={option}
            onClick={() => setView(option)}
            className={`relative inline-flex h-9 w-9 items-center justify-center rounded border transition after:absolute after:-inset-[3px] after:content-[''] md:h-8 md:w-8 ${
              active
                ? "border-[#3B2219] bg-[#3B2219] text-[#FAF7F2]"
                : "border-[#3B2219]/20 text-[#3B2219] hover:border-[#3B2219]"
            }`}
          >
            <ViewGlyph columns={GLYPH_COLUMNS[option]} />
          </button>
        );
      })}
    </div>
  );
}
