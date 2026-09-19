import { expect, test } from "@playwright/test";

const MASTER_LOGO_SOURCE =
  "https://content.pancake.vn/web-media-263/81/58/f0/65/7fe037369d2725ac696f41c14c333f5aa9cc1b6ef94cc2e820687ccc-w:4185-h:2148-l:193993-t:image/png.png";

test("temporary F9a probe: recover canonical master-logo PNG bytes", async ({ page }) => {
  test.setTimeout(90_000);

  try {
    const response = await page.goto("https://www.lanadesign.vn/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(1_000);

    const recovered = await page.evaluate(async (src) => {
      const fetched = await fetch(src);
      const buffer = await fetched.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return {
        src,
        status: fetched.status,
        contentType: fetched.headers.get("content-type"),
        byteLength: bytes.byteLength,
        base64: btoa(binary),
      };
    }, MASTER_LOGO_SOURCE);

    console.log(
      "F9A_MASTER_LOGO_BYTES=" +
        JSON.stringify({
          pageStatus: response?.status() ?? null,
          pageUrl: page.url(),
          ...recovered,
        }),
    );
  } catch (error) {
    console.log(
      "F9A_MASTER_LOGO_ERROR=" +
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  expect("probe-complete").toBe("remove-this-debug-commit");
});
