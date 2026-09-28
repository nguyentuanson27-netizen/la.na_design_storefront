/**
 * ChatGPT Ads Measurement Pixel and Conversions API configuration.
 *
 * The Pixel ID is public configuration but is frozen at image-build time because next.config.mjs
 * opens the CSP from the same value. The Conversions API key is a runtime-only server secret.
 */
const BUILD_TIME_PIXEL_ID = process.env.LA_BUILD_OPENAI_ADS_PIXEL_ID;

const PIXEL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type OpenAiAdsEnvironment = Readonly<Record<string, string | undefined>>;

export type OpenAiAdsPixelConfig = Readonly<{
  pixelId: string;
}>;

export type OpenAiAdsConversionsConfig = Readonly<{
  pixelId: string;
  apiKey: string;
}>;

function readOptionalValue(env: OpenAiAdsEnvironment, name: string): string | null {
  const value = env[name];
  if (value === undefined || value.length === 0) return null;
  if (value !== value.trim()) {
    throw new RangeError(`${name} must not carry leading or trailing whitespace`);
  }
  return value;
}

function defaultEnvironment(): OpenAiAdsEnvironment {
  return { ...process.env, NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: BUILD_TIME_PIXEL_ID };
}

export function readOpenAiAdsPixelConfig(
  env: OpenAiAdsEnvironment = defaultEnvironment(),
): OpenAiAdsPixelConfig | null {
  const pixelId = readOptionalValue(env, "NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID");
  if (pixelId === null) return null;
  if (!PIXEL_ID.test(pixelId)) {
    throw new RangeError(
      "NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID must be the bounded Pixel ID from Ads Manager",
    );
  }
  return Object.freeze({ pixelId });
}

export function readOpenAiAdsConversionsConfig(
  env: OpenAiAdsEnvironment = defaultEnvironment(),
): OpenAiAdsConversionsConfig | null {
  const pixel = readOpenAiAdsPixelConfig(env);
  const apiKey = readOptionalValue(env, "OPENAI_CONVERSIONS_API_KEY");
  if (pixel === null || apiKey === null) return null;
  if (apiKey.length > 4096) {
    throw new RangeError("OPENAI_CONVERSIONS_API_KEY is unexpectedly long");
  }
  return Object.freeze({ pixelId: pixel.pixelId, apiKey });
}
