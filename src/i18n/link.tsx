"use client";

import { forwardRef, type ComponentProps } from "react";
import NextLink from "next/link";

import { localizeHref } from "./locale.ts";
import { useLocale } from "./client.tsx";

type LinkProps = ComponentProps<typeof NextLink>;

/**
 * `next/link` that keeps the shopper in their language: an in-site `href` is put under the current
 * locale's prefix, anything else (an external URL, a `mailto:`, a fragment, an `/api` path) passes
 * through. Use it everywhere the storefront would use `next/link`.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, ...rest }, ref) {
  const locale = useLocale();
  const localized =
    typeof href === "string"
      ? localizeHref(href, locale)
      : typeof href.pathname === "string"
        ? { ...href, pathname: localizeHref(href.pathname, locale) }
        : href;
  return <NextLink ref={ref} href={localized} {...rest} />;
});

export default Link;
