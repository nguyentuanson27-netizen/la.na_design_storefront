/*
 * Outbound-fetch fixture for the virtual try-on browser spec. Preloaded into the Next dev server
 * with `--require`, so the real route, service, product-image fetch, Vertex client and Google auth
 * code all run; only the three remote origins they talk to are answered here:
 *
 *   - https://oauth2.googleapis.com/token         Google ADC token exchange (see below)
 *   - https://<region>-aiplatform.googleapis.com  Vertex AI virtual-try-on-001 `:predict`
 *   - https://content.pancake.vn                  the trusted product image
 *
 * No real credential, network call or Vertex spend is involved. The "Vertex" here validates the
 * request it receives against the spec's required contract and answers by a scenario marker
 * embedded in the shopper photo bytes, so each browser test picks its outcome by choosing its photo.
 * Every predict call is appended to TRY_ON_FIXTURE_LOG so the spec can assert how many were made
 * and what they contained (never the images themselves).
 */
// `process.getBuiltinModule` keeps this a plain preload with no `require()` (the repo lints those).
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
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function log(entry) {
  const file = process.env.TRY_ON_FIXTURE_LOG;
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

const EXPECTED_PATH =
  /^\/v1\/projects\/lana-test-project\/locations\/asia-southeast1\/publishers\/google\/models\/virtual-try-on-001:predict$/;

async function predict(url, init) {
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const instance = body.instances?.[0] ?? {};
  const person = Buffer.from(instance.personImage?.image?.bytesBase64Encoded ?? "", "base64");
  const garment = Buffer.from(instance.productImages?.[0]?.image?.bytesBase64Encoded ?? "", "base64");
  const parameters = body.parameters ?? {};

  log({
    kind: "predict",
    pathOk: EXPECTED_PATH.test(url.pathname),
    authorized: headers.get("authorization") === "Bearer fixture-access-token",
    instances: body.instances?.length,
    productImages: instance.productImages?.length,
    garmentIsTrustedProduct: garment.equals(PRODUCT_JPEG),
    sampleCount: parameters.sampleCount,
    personGeneration: parameters.personGeneration,
    safetySetting: parameters.safetySetting,
    addWatermark: parameters.addWatermark,
    hasStorageUri: JSON.stringify(body).includes("storageUri"),
  });

  if (!EXPECTED_PATH.test(url.pathname) || headers.get("authorization") !== "Bearer fixture-access-token") {
    return json({ error: { code: 403, message: "fixture: unexpected path or credential" } }, 403);
  }

  const marker = person.toString("latin1");
  if (marker.includes("SCENARIO:safety")) {
    return json({ predictions: [{ raiFilteredReason: "Support codes: 00000000" }] });
  }
  if (marker.includes("SCENARIO:fail")) {
    return json({ error: { code: 500, message: "fixture upstream failure" } }, 500);
  }
  if (marker.includes("SCENARIO:slow")) await sleep(1_500);

  return json({ predictions: [{ bytesBase64Encoded: PNG_BASE64, mimeType: "image/png" }] });
}

/*
 * google-auth-library does not use the global `fetch`: its HTTP layer (gaxios -> node-fetch) calls
 * `https.request`. To keep the browser suite hermetic, a request to Google's token endpoint is
 * redirected to a loopback server that answers with a fixed token, so the real auth code runs
 * (service-account JWT signing included) without any call leaving the machine.
 */
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
      `http://127.0.0.1:${tokenServer.address().port}${target.pathname}`,
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

  if (url.hostname === "asia-southeast1-aiplatform.googleapis.com") {
    return predict(url, init ?? (typeof input === "object" && "method" in input ? input : undefined));
  }
  // Only the server-side product-image fetch is answered; the browser never reaches this process.
  if (url.hostname === "content.pancake.vn" && /\.(jpg|jpeg|png|webp)$/.test(url.pathname)) {
    log({ kind: "product-image", path: url.pathname, redirect: init?.redirect });
    return new Response(PRODUCT_JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  return originalFetch(input, init);
};
