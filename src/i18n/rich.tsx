import { Fragment, type ReactNode } from "react";

/**
 * Text with a little inline markup, for prose where a word is bold or a name is a link.
 *
 * Catalog entries stay plain strings so a translator sees the whole sentence: `<strong>…</strong>`,
 * `<em>…</em>` and `<br/>` are the markup, and `{name}` is a slot filled from `values` with any
 * React node (a string, a link). Translating the sentence moves the markup and the slots with it,
 * which is the point: English puts the bold word somewhere else.
 *
 * It is deliberately not HTML. Nothing here is injected as markup, so text can never become script.
 */

const TOKEN = /<(strong|em)>([\s\S]*?)<\/\1>|<br\s*\/?>|\{([A-Za-z0-9_]+)\}/g;

export function renderRich(text: string, values: Readonly<Record<string, ReactNode>> = {}): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index!;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const [whole, tag, inner, slot] = match;
    if (tag === "strong") parts.push(<strong key={key++}>{renderRich(inner!, values)}</strong>);
    else if (tag === "em") parts.push(<em key={key++}>{renderRich(inner!, values)}</em>);
    else if (slot !== undefined) {
      parts.push(Object.hasOwn(values, slot) ? <Fragment key={key++}>{values[slot]}</Fragment> : whole);
    } else parts.push(<br key={key++} />);
    cursor = index + whole.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
