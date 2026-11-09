"use client";

import { usePathname as useAddressBarPathname, useSearchParams } from "next/navigation";

import { useLocale, useT } from "@/i18n/client";
import {
  LANGUAGE_SWITCHER_ORDER,
  LOCALE_LANGUAGE_TAG,
  LOCALE_NATIVE_NAME,
  switchLocalePath,
  type Locale,
} from "@/i18n/locale";

const LANDMARK_NAME = {
  header: "Ngôn ngữ",
  menu: "Ngôn ngữ (menu)",
  footer: "Ngôn ngữ (chân trang)",
} as const;

const SHORT_CODE: Readonly<Record<Locale, string>> = { vi: "VI", en: "EN" };

/**
 * The language switch: the same page, in the other language.
 *
 * Plain anchors rather than client links: a language change re-renders the whole document (the
 * `<html lang>`, the fonts' subsets, the catalog), crawlers should be able to follow it, and it has
 * to work before hydration. The target of each is computed from the address-bar path, so the query
 * (a filter, a page number, a search) comes along. The label of each option is in its own language
 * and carries its own `lang`, as a screen reader needs to pronounce it.
 */
export function LanguageSwitcher({
  className,
  placement,
}: Readonly<{
  className?: string;
  /**
   * Where this copy sits. The header, the mobile menu and the footer each carry one, and a page may
   * not hold several navigation landmarks with the same name, so each is named for its place.
   */
  placement: "header" | "menu" | "footer";
}>) {
  const t = useT();
  const current = useLocale();
  const pathname = useAddressBarPathname();
  const query = useSearchParams().toString();

  return (
    <nav
      className={className}
      aria-label={t(LANDMARK_NAME[placement])}
      data-language-switcher=""
    >
      <ul className="flex items-center gap-1.5">
        {LANGUAGE_SWITCHER_ORDER.map((locale, index) => {
          const isCurrent = locale === current;
          const href = `${switchLocalePath(pathname, locale)}${query.length > 0 ? `?${query}` : ""}`;
          return (
            <li key={locale} className="flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true" className="opacity-40">/</span> : null}
              {isCurrent ? (
                <span aria-current="true" lang={LOCALE_LANGUAGE_TAG[locale]} title={LOCALE_NATIVE_NAME[locale]}>
                  <strong className="font-semibold">{SHORT_CODE[locale]}</strong>
                </span>
              ) : (
                <a
                  href={href}
                  lang={LOCALE_LANGUAGE_TAG[locale]}
                  hrefLang={LOCALE_LANGUAGE_TAG[locale]}
                  title={LOCALE_NATIVE_NAME[locale]}
                  className="underline-offset-4 hover:underline focus-visible:underline"
                >
                  {SHORT_CODE[locale]}
                  <span className="sr-only"> — {LOCALE_NATIVE_NAME[locale]}</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
