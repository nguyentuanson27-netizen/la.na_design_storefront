import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_SPEC_SECONDS,
  parseTestMatch,
  planShards,
  shardSeconds,
  specFilter,
} from "../../scripts/a11y-shard-plan.ts";

/**
 * The browser suite is split across CI shards by file. A shard that dropped a file would stop
 * testing it with nothing red to say so, so what these pin is the partition itself: every file the
 * Playwright config runs is in exactly one shard, whatever the shard count, and the file filters
 * handed to Playwright select exactly those files and no neighbour.
 */

const DIR = new URL("../../tests/a11y-runtime/", import.meta.url);
const files = parseTestMatch(readFileSync(new URL("playwright.config.ts", DIR), "utf8"));
const { _comment: _ignored, ...weights } = JSON.parse(
  readFileSync(new URL("shard-weights.json", DIR), "utf8"),
) as Record<string, number | string>;
const numericWeights = weights as Record<string, number>;
const specFilesOnDisk = readdirSync(DIR).filter((name) => name.endsWith(".spec.ts"));

test("the config lists real spec files, once each", () => {
  assert.ok(files.length > 50, "the suite is parsed out of the config, not guessed");
  assert.equal(new Set(files).size, files.length, "a file listed twice would run twice");
  for (const file of files) assert.ok(specFilesOnDisk.includes(file), `${file} is in testMatch but not on disk`);
});

test("no timing is kept for a file the suite no longer runs", () => {
  for (const file of Object.keys(numericWeights)) {
    assert.ok(files.includes(file), `${file} has a weight but is not in testMatch: remove it from shard-weights.json`);
  }
});

for (const shardCount of [1, 2, 3, 4, 5, 6, 7, 8, 12]) {
  test(`${shardCount} shard(s): every spec file lands in exactly one shard`, () => {
    const plan = planShards({ files, weights: numericWeights, shardCount });
    assert.equal(plan.length, shardCount);
    const placed = plan.flat();
    assert.equal(placed.length, files.length, "nothing dropped, nothing duplicated");
    assert.deepEqual([...placed].sort(), [...files].sort());
    for (const shard of plan) assert.ok(shard.length > 0, "a shard with no file would make Playwright run the whole suite");
  });
}

test("the same input always gives the same plan, so every shard computes the same split", () => {
  const first = planShards({ files, weights: numericWeights, shardCount: 6 });
  const second = planShards({ files: [...files].reverse(), weights: numericWeights, shardCount: 6 });
  assert.deepEqual(first, second);
});

test("six shards come out balanced by time, not by count", () => {
  const plan = planShards({ files, weights: numericWeights, shardCount: 6 });
  const seconds = shardSeconds(plan, numericWeights);
  const mean = seconds.reduce((a, b) => a + b, 0) / seconds.length;
  const largestFile = Math.max(...files.map((file) => numericWeights[file] ?? DEFAULT_SPEC_SECONDS));
  assert.ok(
    Math.max(...seconds) <= Math.max(mean * 1.1, largestFile),
    `slowest shard ${Math.max(...seconds)}s against a mean of ${Math.round(mean)}s`,
  );
  assert.ok(Math.min(...seconds) >= mean * 0.9, `fastest shard ${Math.min(...seconds)}s against a mean of ${Math.round(mean)}s`);
});

test("a file with no measured weight is still placed, at the default", () => {
  const plan = planShards({ files: ["a.spec.ts", "b.spec.ts", "new.spec.ts"], weights: { "a.spec.ts": 100, "b.spec.ts": 100 }, shardCount: 2 });
  assert.deepEqual(plan.flat().sort(), ["a.spec.ts", "b.spec.ts", "new.spec.ts"]);
  assert.deepEqual(
    shardSeconds(plan, { "a.spec.ts": 100, "b.spec.ts": 100 }).sort((a, b) => a - b),
    [DEFAULT_SPEC_SECONDS + 100, 100].sort((a, b) => a - b),
  );
});

test("a file filter selects its own spec file and no other in the directory", () => {
  for (const file of specFilesOnDisk) {
    const filter = new RegExp(specFilter(file).replace(/^\//, "/"), "gi");
    const selected = specFilesOnDisk.filter((other) => {
      filter.lastIndex = 0;
      return filter.test(`/repo/tests/a11y-runtime/${other}`);
    });
    assert.deepEqual(selected, [file], `${specFilter(file)} must select only ${file}`);
  }
});

test("the workflow takes its shard count from the matrix and refuses to run an empty shard", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /a11y-shard-plan\.ts "\$\{\{ matrix\.shard \}\}" "\$\{\{ strategy\.job-total \}\}"/);
  assert.match(ci, /test "\$\{#SPECS\[@\]\}" -gt 0/, "no filter would make Playwright run every test on every shard");
  assert.doesNotMatch(ci, /--shard=/, "Playwright's own sharding must not be applied on top of the plan");
});
