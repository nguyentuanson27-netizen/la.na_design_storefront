import { expect, test } from "@playwright/test";

test("temporary F9a probe: recover canonical production brand-mark candidates", async ({ page }) => {
  test.setTimeout(90_000);

  try {
    const response = await page.goto("https://www.lanadesign.vn/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    const result = await page.evaluate(async () => {
      const absolute = (value: string) => {
        try {
          return new URL(value, location.href).href;
        } catch {
          return value;
        }
      };

      const imageCandidates = [...document.images]
        .map((image) => {
          const rect = image.getBoundingClientRect();
          return {
            kind: "img" as const,
            src: image.currentSrc || image.src,
            alt: image.alt,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            renderedWidth: Math.round(rect.width),
            renderedHeight: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            parentHref: image.closest("a")?.getAttribute("href") ?? null,
            outerHTML: image.outerHTML.slice(0, 2_000),
          };
        })
        .filter(
          (entry) =>
            Boolean(entry.src) &&
            (entry.parentHref === "/" ||
              entry.parentHref === "https://www.lanadesign.vn/" ||
              (entry.top >= 0 && entry.top < 220)),
        )
        .slice(0, 20);

      const backgroundCandidates = [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const match = style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
          return {
            kind: "background" as const,
            src: match?.[1] ? absolute(match[1]) : "",
            tag: element.tagName,
            className: String(element.className),
            text: element.textContent?.trim().slice(0, 120) ?? "",
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            renderedWidth: Math.round(rect.width),
            renderedHeight: Math.round(rect.height),
            parentHref: element.closest("a")?.getAttribute("href") ?? null,
          };
        })
        .filter(
          (entry) =>
            Boolean(entry.src) &&
            (entry.parentHref === "/" ||
              entry.parentHref === "https://www.lanadesign.vn/" ||
              (entry.top >= 0 && entry.top < 220)),
        )
        .slice(0, 20);

      const inlineSvgs = [...document.querySelectorAll<SVGElement>("svg")]
        .map((svg) => {
          const rect = svg.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            renderedWidth: Math.round(rect.width),
            renderedHeight: Math.round(rect.height),
            parentHref: svg.closest("a")?.getAttribute("href") ?? null,
            html: svg.outerHTML.slice(0, 20_000),
          };
        })
        .filter(
          (entry) =>
            entry.parentHref === "/" ||
            entry.parentHref === "https://www.lanadesign.vn/" ||
            (entry.top >= 0 && entry.top < 220),
        )
        .slice(0, 20);

      const urls = [...new Set([...imageCandidates, ...backgroundCandidates].map((entry) => entry.src))];
      const recovered: Array<Record<string, unknown>> = [];
      for (const src of urls) {
        try {
          const fetched = await fetch(src);
          const buffer = await fetched.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = "";
          if (bytes.byteLength <= 512_000) {
            for (let index = 0; index < bytes.length; index += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
            }
          }
          recovered.push({
            src,
            status: fetched.status,
            contentType: fetched.headers.get("content-type"),
            byteLength: bytes.byteLength,
            base64: bytes.byteLength <= 512_000 ? btoa(binary) : null,
          });
        } catch (error) {
          recovered.push({ src, error: error instanceof Error ? error.message : String(error) });
        }
      }

      const homeLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/"], a[href="https://www.lanadesign.vn/"]')]
        .map((link) => ({
          text: link.textContent?.trim() ?? "",
          html: link.innerHTML.slice(0, 20_000),
          className: link.className,
        }))
        .slice(0, 20);

      return { imageCandidates, backgroundCandidates, inlineSvgs, recovered, homeLinks };
    });

    console.log("F9A_LOGO_PROBE=" + JSON.stringify({
      status: response?.status() ?? null,
      url: page.url(),
      ...result,
    }));
  } catch (error) {
    console.log("F9A_LOGO_PROBE_ERROR=" + JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  // Deliberate debug stop. This commit is temporary and will be removed after the asset is recovered.
  expect("probe-complete").toBe("remove-this-debug-commit");
});
