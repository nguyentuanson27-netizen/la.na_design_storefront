import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // `.next-test/**` holds the per-spec build directories the browser suite writes. It is
  // gitignored, but a developer who lints after running that suite would otherwise be linting
  // Next's generated output.
  globalIgnores([".next/**", ".next-test/**", "node_modules/**", "tests/fixtures/**"]),
]);
