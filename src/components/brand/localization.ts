"use client";

/**
 * The language hooks, for pages (`src/app`) and anything else outside the brand layer's own
 * imports. Pages reach only the brand layer, the routes and the brand config, so the hooks come
 * through here; they live in `@/i18n/client`.
 */
export { useLocale, useRich, useT } from "@/i18n/client";
