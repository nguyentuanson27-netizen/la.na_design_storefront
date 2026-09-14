import assert from "node:assert/strict";
import test from "node:test";

import { serializeJsonLd } from "../../src/seo/structured-data.ts";

/**
 * The exact payload from spec 04 §7: a value that closes the JSON-LD script element and opens a new
 * one. If it reaches the page as raw `<`, the browser leaves JSON-LD and starts executing script.
 *
 * `route-handle-contract.test.ts` proves the shell hands `payload.structuredData` straight to this
 * function and implements no escaping of its own, so what runs here is the code that runs in the
 * shell. Executing it directly is possible because the serializer is a `.ts` module; the shell is
 * `.tsx` and this runner cannot load it.
 */
const BREAKOUT = "</script><script>alert(1)</script>";

function renderJsonLdFromShell(...entities: Record<string, unknown>[]): string {
  return serializeJsonLd(entities);
}

test("a script-breakout payload cannot leave the shell as raw markup", () => {
  const output = renderJsonLdFromShell({ "@context": "https://schema.org", name: BREAKOUT });

  assert.equal(output.includes("<"), false, "no raw < survives into the document");
  assert.equal(output.includes("\\u003c"), true, "the escape the serializer is supposed to apply");
  assert.equal(output.includes("</script>"), false);
});

test("the escaped payload still parses back to the original JSON-LD", () => {
  const output = renderJsonLdFromShell({ "@context": "https://schema.org", name: BREAKOUT });

  // Escaping that corrupted the data would be a different bug wearing the same green test. A browser
  // parses this back to the original string; so does this assertion.
  const parsed = JSON.parse(output) as [{ name: string }];
  assert.equal(parsed[0].name, BREAKOUT);
});

test("the guard holds for a payload nested deep inside an entity", () => {
  const output = renderJsonLdFromShell({
    "@context": "https://schema.org",
    "@graph": [{ offers: { seller: { name: BREAKOUT } } }],
  });

  assert.equal(output.includes("<"), false);
  assert.equal(output.includes("\\u003c"), true);
});

test("the guard holds for a breakout hidden in a key rather than a value", () => {
  const output = renderJsonLdFromShell({ [`${BREAKOUT}`]: "value" });

  assert.equal(output.includes("<"), false);
  assert.equal(output.includes("\\u003c"), true);
});

test("every < in a multi-entity document is escaped, not just the first", () => {
  const output = renderJsonLdFromShell(
    { "@context": "https://schema.org", name: BREAKOUT },
    { "@context": "https://schema.org", description: `a < b < c` },
  );

  assert.equal(output.includes("<"), false);
  assert.equal((output.match(/\\u003c/g) ?? []).length, 5, "all five < are escaped: three in the breakout, two in the second entity");
});

test("the serializer is not vacuously passing on input that never contained a bracket", () => {
  // Guards the guard: if serializeJsonLd started returning "" or dropping fields, every assertion
  // above would still be green.
  const output = renderJsonLdFromShell({ "@context": "https://schema.org", name: "plain" });

  assert.equal(output.includes("\\u003c"), false);
  assert.deepEqual(JSON.parse(output), [{ "@context": "https://schema.org", name: "plain" }]);
});
