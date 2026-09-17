import { ImageResponse } from "next/og";
import { createElement } from "react";
import { BRAND } from "@/brand";

export const dynamic = "force-static";

/**
 * Dynamic social card placeholder generated via ImageResponse (1200x630).
 * Pending owner-supplied static social card asset per F1 contract.
 */
const CARD_SIZE = { width: 1200, height: 630 } as const;

export function GET() {
  return new ImageResponse(
    createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f4f0e8",
          color: "#111111",
          padding: "72px 80px",
        },
      },
      createElement(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 34,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          },
        },
        BRAND.identity.name,
      ),
      createElement(
        "div",
        {
          style: {
            display: "flex",
            maxWidth: 900,
            fontSize: 92,
            fontWeight: 700,
            lineHeight: 0.96,
            letterSpacing: "-0.04em",
          },
        },
        BRAND.identity.strapline,
      ),
      createElement(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 24,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          },
        },
        "Official product social preview",
      ),
    ),
    CARD_SIZE,
  );
}
