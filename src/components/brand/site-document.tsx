import type { ReactNode } from "react";
import { Josefin_Sans, Mulish } from "next/font/google";

import { StorefrontAnchorScroll } from "@/components/brand/storefront-anchor-scroll";
import { I18nProvider } from "@/i18n/client";
import { LOCALE_LANGUAGE_TAG, type Locale } from "@/i18n/locale";
import type { Messages } from "@/i18n/translate";

// The stylesheet stays at the App Router's conventional location and is imported from here, because
// the document element is what it styles. A brand redraw owns both this file and that stylesheet;
// neither is shared-layer code.
import "@/app/globals.css";

/** Display face: headings, product names, category labels, navigation, prices and buttons. */
const josefin = Josefin_Sans({
  subsets: ["latin", "vietnamese"],
  variable: "--font-display-face",
  display: "swap",
});

/** Body face: everything read at length -- descriptions, small print, forms. */
const mulish = Mulish({
  subsets: ["latin", "vietnamese"],
  variable: "--font-body-face",
  display: "swap",
});

const fontVariables = `${josefin.variable} ${mulish.variable}`;

/**
 * The document a brand ships: the element the typeface, the language and the global stylesheet hang
 * off, and nothing else.
 *
 * It wraps rather than composes. Everything inside `<body>` -- the tracking bootstrap, the site
 * JSON-LD, the masthead, the page, the footer, the Meta pixel -- is placed by `SiteChrome`, so a
 * redraw that rewrites this file cannot reorder or drop any of them. What it can change is the
 * typeface, the language and the stylesheet, which is the whole of what a document contributes.
 */
export function SiteDocument({
  locale,
  messages,
  children,
}: Readonly<{ locale: Locale; messages: Messages; children: ReactNode }>) {
  // `globals.css` makes in-page scrolling smooth. Since Next 16 that also animates the jump to the
  // top of a newly opened page unless this attribute is present, which is what lets the router
  // switch to an instant scroll for the navigation itself.
  return (
    <html lang={LOCALE_LANGUAGE_TAG[locale]} className={fontVariables} data-scroll-behavior="smooth">
      <body className={fontVariables}>
        <I18nProvider locale={locale} messages={messages}>
          <StorefrontAnchorScroll />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
