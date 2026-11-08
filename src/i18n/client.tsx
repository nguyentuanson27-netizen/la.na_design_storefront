"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { DEFAULT_LOCALE, localizeHref, splitLocalePath, type Locale } from "./locale.ts";
import { createTranslator, type Messages, type Translator } from "./translate.ts";

type I18nContextValue = Readonly<{ locale: Locale; messages: Messages }>;

const I18nContext = createContext<I18nContextValue>({ locale: DEFAULT_LOCALE, messages: {} });

/**
 * Carries the request's locale, and for English the messages, into client components. The server
 * passes `messages` only when the locale needs them, so a Vietnamese page ships no catalog.
 */
export function I18nProvider({
  locale,
  messages,
  children,
}: Readonly<{ locale: Locale; messages: Messages; children: ReactNode }>) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export function useT(): Translator {
  const { locale, messages } = useContext(I18nContext);
  return useMemo(() => createTranslator(locale, messages), [locale, messages]);
}

/** Puts an in-site href under the current locale's prefix. */
export function useLocalizedHref(): (href: string) => string {
  const locale = useLocale();
  return useMemo(() => (href: string) => localizeHref(href, locale), [locale]);
}

/**
 * The route path without the locale prefix. `usePathname()` reports the URL in the address bar --
 * `/en/shop` -- while every comparison in the storefront (active nav item, breadcrumbs, "is this the
 * cart page") is written against the route, `/shop`.
 */
export function useRoutePathname(): string {
  return splitLocalePath(usePathname()).pathname;
}
