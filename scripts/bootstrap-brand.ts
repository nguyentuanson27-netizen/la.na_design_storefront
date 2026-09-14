/**
 * One-time fork bootstrap.
 *
 * Reads the committed project identity, generates .env.local from .env.example, renames the social
 * card route to the new project slug, updates the package name and prints the checklist of things
 * a human still has to do. It never generates a secret and never overwrites an existing .env.local.
 *
 *   pnpm bootstrap:brand
 */

import { bootstrapBrand } from "../src/operations/bootstrap-brand.ts";

try {
  const summary = bootstrapBrand({ rootDir: process.cwd() });

  process.stdout.write(`Bootstrapped project "${summary.projectSlug}".\n`);
  process.stdout.write(`  Wrote ${summary.envLocalPath} (secrets left blank).\n`);
  process.stdout.write(
    summary.socialCardRoute.renamed
      ? `  Renamed social card route ${summary.socialCardRoute.from} -> ${summary.socialCardRoute.to}.\n`
      : `  Social card route ${summary.socialCardRoute.to} already matches the project slug.\n`,
  );
  process.stdout.write(`  Set package.json name to "${summary.packageName}".\n`);
  process.stdout.write("\nStill required, by hand:\n");
  for (const item of summary.manualChecklist) {
    process.stdout.write(`  - ${item}\n`);
  }
} catch (error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "Unknown bootstrap error";
  process.stderr.write(`bootstrap:brand failed: ${name}: ${message}\n`);
  process.exitCode = 1;
}
