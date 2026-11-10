import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Splits the browser accessibility suite across its CI shards by how long each spec file takes.
 *
 * Playwright's own `--shard` hands each shard a block of consecutive files holding about the same
 * number of tests, not the same amount of time. Here a few files are several minutes (`try-on`,
 * `facebook-pixel`, `checkout-benefit`) and many are seconds, so equal counts gave shards of 4 to 8.5
 * minutes while the run waited for the slowest. This puts the longest files first and always gives
 * the next one to the lightest shard (longest-processing-time-first), which is within a third of the
 * best possible split and here lands within a few percent of equal.
 *
 * It decides only which FILES a shard runs. A shard that dropped a file would silently stop testing
 * it, so the plan is a pure function with a test (`tests/domain/a11y-shard-plan.test.ts`) that every
 * file in `testMatch` lands in exactly one shard, and the CLI refuses to print an empty shard
 * (Playwright given no file filter runs everything).
 *
 *   node --experimental-strip-types scripts/a11y-shard-plan.ts <shard, 1-based> <of>
 *
 * prints one anchored regex per line, which Playwright takes as file filters.
 */

/** Seconds assumed for a file with no measured weight, so a new spec needs no edit here. */
export const DEFAULT_SPEC_SECONDS = 15;

/** The spec files the Playwright config runs: the entries of its top-level `testMatch` array. */
export function parseTestMatch(configSource: string): string[] {
  const block = /testMatch:\s*\[([\s\S]*?)\]/.exec(configSource);
  if (!block) throw new Error("playwright.config.ts has no testMatch array");
  const names = [...block[1]!.matchAll(/"([^"]+\.spec\.ts)"/g)].map((match) => match[1]!);
  if (names.length === 0) throw new Error("the testMatch array lists no spec files");
  return names;
}

export function planShards({
  files,
  weights,
  shardCount,
  defaultSeconds = DEFAULT_SPEC_SECONDS,
}: Readonly<{
  files: readonly string[];
  weights: Readonly<Record<string, number>>;
  shardCount: number;
  defaultSeconds?: number;
}>): string[][] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be a positive integer");
  const unique = [...new Set(files)];
  const weightOf = (file: string) => {
    const weight = weights[file];
    return typeof weight === "number" && weight > 0 ? weight : defaultSeconds;
  };

  const shards = Array.from({ length: shardCount }, () => ({ load: 0, files: [] as string[] }));
  const heaviestFirst = [...unique].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  for (const file of heaviestFirst) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.load < lightest.load) lightest = shard;
    lightest.files.push(file);
    lightest.load += weightOf(file);
  }
  // Alphabetical inside a shard, as Playwright ordered them before.
  return shards.map((shard) => shard.files.sort((a, b) => a.localeCompare(b)));
}

/** How long a plan's shards are expected to run, for the log and the tests. */
export function shardSeconds(
  plan: readonly (readonly string[])[],
  weights: Readonly<Record<string, number>>,
  defaultSeconds = DEFAULT_SPEC_SECONDS,
): number[] {
  return plan.map((files) =>
    files.reduce((sum, file) => sum + (weights[file] && weights[file]! > 0 ? weights[file]! : defaultSeconds), 0),
  );
}

/**
 * A Playwright file filter for exactly one spec file. Positional arguments are regular expressions
 * matched against the whole path, so the name is anchored at both ends: `checkout.spec.ts` must not
 * also select `checkout-benefit.spec.ts`, and `pdp-promotion.spec.ts` not `pdp-promotion-offers.spec.ts`.
 */
export function specFilter(file: string): string {
  return `/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function main() {
  const [shardArg, ofArg] = process.argv.slice(2);
  const shard = Number(shardArg);
  const shardCount = Number(ofArg);
  if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shard < 1 || shard > shardCount) {
    console.error("usage: a11y-shard-plan.ts <shard, 1-based> <of>");
    process.exit(2);
  }

  const dir = new URL("../tests/a11y-runtime/", import.meta.url);
  const files = parseTestMatch(readFileSync(new URL("playwright.config.ts", dir), "utf8"));
  const { _comment: _ignored, ...weights } = JSON.parse(
    readFileSync(new URL("shard-weights.json", dir), "utf8"),
  ) as Record<string, number | string>;
  const plan = planShards({ files, weights: weights as Record<string, number>, shardCount });
  const mine = plan[shard - 1]!;
  if (mine.length === 0) {
    console.error(`shard ${shard}/${shardCount} would run no spec file: there are ${files.length} files`);
    process.exit(1);
  }
  const seconds = shardSeconds(plan, weights as Record<string, number>).map((s) => Math.round(s));
  console.error(
    `shard ${shard}/${shardCount}: ${mine.length} of ${files.length} spec files, ~${seconds[shard - 1]}s ` +
      `(all shards ~${seconds.join("s, ")}s)`,
  );
  for (const file of mine) console.log(specFilter(file));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
