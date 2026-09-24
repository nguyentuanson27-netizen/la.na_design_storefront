import type { ReactNode } from "react";
import { Josefin_Sans, Mulish } from "next/font/google";

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
export function SiteDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi" className={fontVariables}>
      <body className={fontVariables}>{children}</body>
    </html>
  );
}
