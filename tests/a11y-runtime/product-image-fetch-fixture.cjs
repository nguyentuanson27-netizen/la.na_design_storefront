/*
 * Hermetic upstream for the PDP image optimizer smoke. Only the reviewed Pancake media origin is
 * intercepted: it answers every image path with the same deterministic, deliberately incompressible
 * PNG so the optimizer's WebP output spans many response chunks. Everything else is left alone.
 */
const { createRequire } = process.getBuiltinModule("node:module");
const loadFromApp = createRequire(__filename);
const originalFetch = globalThis.fetch;
let pngPromise;

function noisePng() {
  pngPromise ??= (async () => {
    const sharp = loadFromApp("sharp");
    const width = 900;
    const height = 900;
    const raw = Buffer.alloc(width * height * 3);
    let state = 0x9e3779b9;
    for (let i = 0; i < raw.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[i] = state >>> 24;
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  })();
  return pngPromise;
}

globalThis.fetch = async function productImageFixtureFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  if (url.protocol === "https:" && url.hostname === "content.pancake.vn") {
    const png = await noisePng();
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  }
  return originalFetch(input, init);
};
