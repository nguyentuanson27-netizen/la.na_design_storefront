import { test } from "@playwright/test";

test("temporary F9a probe: inspect canonical production brand-mark sources", async ({ page }) => {
  test.setTimeout(90_000);

  try {
    const response = await page.goto("https://www.lanadesign.vn/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const result = await page.evaluate(() => {
      const images = [...document.images].map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          alt: image.alt,
          width: image.naturalWidth,
          height: image.naturalHeight,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          className: image.className,
          parentHref: image.closest("a")?.getAttribute("href") ?? null,
        };
      });

      const homeLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/"], a[href="https://www.lanadesign.vn/"]')]
        .map((link) => ({
          text: link.textContent?.trim() ?? "",
          html: link.innerHTML.slice(0, 1200),
          className: link.className,
        }))
        .slice(0, 20);

      const backgroundImages = [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            className: element.className,
            backgroundImage: style.backgroundImage,
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter(
          (entry) =>
            entry.backgroundImage !== "none" &&
            entry.top < 700 &&
            entry.width > 20 &&
            entry.height > 20,
        )
        .slice(0, 30);

      return { images, homeLinks, backgroundImages };
    });

    console.log(
      "F9A_LOGO_PROBE=" +
        JSON.stringify({
          status: response?.status() ?? null,
          url: page.url(),
          ...result,
        }),
    );
  } catch (error) {
    console.log(
      "F9A_LOGO_PROBE_ERROR=" +
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }
});
