/*
 * Hermetic outbound fixture for virtual try-on browser tests.
 * The real route/service/auth/provider adapter run; only external origins are intercepted.
 */
const { appendFileSync } = process.getBuiltinModule("node:fs");
const http = process.getBuiltinModule("node:http");
const https = process.getBuiltinModule("node:https");

const originalFetch = globalThis.fetch;
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALgAJHb/2Q==";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOwiaogCTGMahjVMHw1AABPQw4Q5oG1CgAAAABJRU5ErkJggg==";
const PRODUCT_JPEG = Buffer.from(JPEG_BASE64, "base64");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function log(entry) {
  const file = process.env.TRY_ON_FIXTURE_LOG;
  if (file) appendFileSync(file, JSON.stringify(entry) + "\n");
}

const EXPECTED_PATH =
  /^\/v1\/projects\/lana-test-project\/locations\/global\/publishers\/google\/models\/gemini-3-pro-image:generateContent$/;

async function generate(url, init) {
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const contents = Array.isArray(body.contents) ? body.contents : [body.contents];
  const parts = contents[0]?.parts ?? [];
  const imageParts = parts.filter((part) => part?.inlineData);
  const prompt = parts.filter((part) => typeof part?.text === "string").map((part) => part.text).join(" ");
  const person = Buffer.from(imageParts[0]?.inlineData?.data ?? "", "base64");
  const garment = Buffer.from(imageParts[1]?.inlineData?.data ?? "", "base64");
  const generationConfig = body.generationConfig ?? {};
  const imageConfig = generationConfig.imageConfig ?? {};
  const safetySettings = Array.isArray(body.safetySettings) ? body.safetySettings : [];

  log({
    kind: "predict",
    pathOk: EXPECTED_PATH.test(url.pathname),
    authorized: headers.get("authorization") === "Bearer fixture-access-token",
    contents: contents.length,
    inputImages: imageParts.length,
    garmentIsTrustedProduct: garment.equals(PRODUCT_JPEG),
    candidateCount: generationConfig.candidateCount,
    mediaResolution: generationConfig.mediaResolution,
    imageSize: imageConfig.imageSize,
    personGeneration: imageConfig.personGeneration,
    responseModalities: generationConfig.responseModalities,
    safetyThresholds: safetySettings.map((setting) => setting.threshold),
    hasPrompt: prompt.toLowerCase().includes("photorealistic try-on"),
    hasStorageUri: /storageUri|gcsUri|fileUri/.test(JSON.stringify(body)),
  });

  if (!EXPECTED_PATH.test(url.pathname) || headers.get("authorization") !== "Bearer fixture-access-token") {
    return json({ error: { code: 403, message: "fixture: unexpected path or credential" } }, 403);
  }

  const marker = person.toString("latin1");
  if (marker.includes("SCENARIO:safety")) return json({ promptFeedback: { blockReason: "IMAGE_SAFETY" } });
  if (marker.includes("SCENARIO:fail")) return json({ error: { code: 500, message: "fixture upstream failure" } }, 500);
  if (marker.includes("SCENARIO:slow")) await sleep(1_500);

  return json({
    candidates: [{
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [
          { text: "Generated virtual try-on." },
          { inlineData: { data: PNG_BASE64, mimeType: "image/png" } },
        ],
      },
    }],
  });
}

const tokenServer = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: "fixture-access-token", expires_in: 3600, token_type: "Bearer" }));
  });
});
tokenServer.listen(0, "127.0.0.1");
tokenServer.unref();

const realHttpsRequest = https.request;
https.request = function tryOnFixtureHttpsRequest(...args) {
  let target = null;
  try {
    const first = args[0];
    target = typeof first === "string" || first instanceof URL ? new URL(first) : null;
  } catch {
    target = null;
  }
  if (target && target.hostname === "oauth2.googleapis.com") {
    const options = typeof args[1] === "object" && args[1] !== null ? args[1] : {};
    const callback = args.find((arg) => typeof arg === "function");
    return http.request(
      "http://127.0.0.1:" + tokenServer.address().port + target.pathname,
      { method: options.method, headers: options.headers, signal: options.signal },
      callback,
    );
  }
  return realHttpsRequest.apply(this, args);
};

globalThis.fetch = async function tryOnFixtureFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  } catch {
    return originalFetch(input, init);
  }
  if (url.hostname === "aiplatform.googleapis.com") {
    return generate(url, init ?? (typeof input === "object" && "method" in input ? input : undefined));
  }
  if (url.hostname === "content.pancake.vn" && /\.(jpg|jpeg|png|webp)$/.test(url.pathname)) {
    log({ kind: "product-image", path: url.pathname, redirect: init?.redirect });
    return new Response(PRODUCT_JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  return originalFetch(input, init);
};
