import type { ReactNode } from "react";

import type { Translator } from "./translate.ts";

/**
 * The values of a rich sentence, with the text ones passed through `t`.
 *
 * `renderRich(t(source), values)` fills the slots after `t` has run, so a dong amount handed in as
 * a slot would reach an English page unconverted. Strings go through `t` first (a dollar figure on
 * `/en`, themselves on `/`); React nodes are left as they are.
 */
export function richValues(
  t: Translator,
  values: Readonly<Record<string, ReactNode>> | undefined,
): Readonly<Record<string, ReactNode>> | undefined {
  if (values === undefined) return undefined;
  const out: Record<string, ReactNode> = {};
  for (const [name, value] of Object.entries(values)) out[name] = typeof value === "string" ? t(value) : value;
  return out;
}
