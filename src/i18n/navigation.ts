"use client";

import { useMemo } from "react";
import { useRouter as useNextRouter, usePathname as useNextPathname } from "next/navigation";

import { useLocale } from "./client.tsx";
import { localizeHref, splitLocalePath } from "./locale.ts";

type NextRouter = ReturnType<typeof useNextRouter>;

/**
 * `next/navigation`'s router, keeping the shopper in their language: `push`, `replace` and
 * `prefetch` put an in-site href under the current locale's prefix first (a path that already has
 * it, or is not a page, is left alone).
 */
export function useRouter(): NextRouter {
  const router = useNextRouter();
  const locale = useLocale();
  return useMemo<NextRouter>(
    () => ({
      ...router,
      push: (href, options) => router.push(localizeHref(href, locale), options),
      replace: (href, options) => router.replace(localizeHref(href, locale), options),
      prefetch: (href, options) => router.prefetch(localizeHref(href, locale), options),
    }),
    [router, locale],
  );
}

/**
 * The route path, without the language prefix. `/en/shop` is the page `/shop`, and every comparison
 * in the storefront (the active menu item, "is this the cart") is written against the route.
 */
export function usePathname(): string {
  return splitLocalePath(useNextPathname()).pathname;
}
