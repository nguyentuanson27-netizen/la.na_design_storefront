import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readProjectConfig, type ProjectConfig } from "../config/project-config.ts";

export type SocialCardRouteRename = Readonly<{
  from: string;
  to: string;
  renamed: boolean;
}>;

export type BootstrapBrandSummary = Readonly<{
  projectSlug: string;
  envLocalPath: string;
  socialCardRoute: SocialCardRouteRename;
  packageName: string;
  manualChecklist: readonly string[];
}>;

export type BootstrapBrandOptions = Readonly<{
  rootDir: string;
}>;

const SOCIAL_CARD_ROUTE_SUFFIX = "-social-card.png";

/**
 * Everything a fork needs that this script is not allowed to do for it. These are credentials,
 * external account setup and an indexing decision: each one needs a human who can be accountable
 * for the value, so the script names them and stops.
 */
const MANUAL_CHECKLIST: readonly string[] = [
  "Create the new Pancake shop and copy PANCAKE_API_KEY / PANCAKE_SHOP_ID into .env.local by hand.",
  "Generate a fresh BETTER_AUTH_SECRET (>= 32 random characters) yourself; this script never mints one.",
  "Verify the sending domain in Resend and copy RESEND_API_KEY into .env.local by hand.",
  "Create the new Meta Pixel and copy NEXT_PUBLIC_FACEBOOK_PIXEL_ID and FACEBOOK_CAPI_ACCESS_TOKEN in by hand.",
  "Point DNS at the new production domain and provision TLS.",
  "Leave SEARCH_INDEXING_ENABLED=false until the launch gate and an explicit human indexing approval are complete.",
  "Update src/brand/* with the new brand's owner-approved facts, including identity.socialCardSlug.",
] as const;

function rewriteDatabaseUrlLine(line: string, databaseName: string): string {
  const separator = line.indexOf("=");
  const rawValue = line.slice(separator + 1);
  const quote = rawValue.startsWith('"') && rawValue.endsWith('"') ? '"' : "";
  const value = quote === "" ? rawValue : rawValue.slice(1, -1);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      ".env.example DATABASE_URL must be a valid PostgreSQL URL so the database identity can be rewritten",
    );
  }
  url.pathname = `/${databaseName}`;

  return `DATABASE_URL=${quote}${url.toString()}${quote}`;
}

/**
 * Generates .env.local from .env.example, substituting only the values project.config.json already
 * owns. Every other line, secret placeholders included, is copied through byte for byte.
 */
function renderEnvLocal(envExample: string, config: ProjectConfig): string {
  return envExample
    .split("\n")
    .map((line) =>
      line.startsWith("DATABASE_URL=") ? rewriteDatabaseUrlLine(line, config.databaseName) : line,
    )
    .join("\n");
}

function resolveSocialCardRoute(appDir: string, projectSlug: string): SocialCardRouteRename {
  let entries: readonly string[];
  try {
    entries = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(SOCIAL_CARD_ROUTE_SUFFIX))
      .map((entry) => entry.name);
  } catch {
    throw new Error(`Cannot read the app router directory at ${appDir}`);
  }

  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one social card route directory ending in "${SOCIAL_CARD_ROUTE_SUFFIX}" under ${appDir}, found ${entries.length}`,
    );
  }

  const from = entries[0] as string;
  const to = `${projectSlug}${SOCIAL_CARD_ROUTE_SUFFIX}`;
  return { from, to, renamed: from !== to };
}

function rewritePackageName(packageJson: string, projectSlug: string): string {
  const namePattern = /^(\s*"name"\s*:\s*)"[^"]*"/m;
  if (!namePattern.test(packageJson)) {
    throw new Error('package.json must declare a top-level "name" to rewrite');
  }
  return packageJson.replace(namePattern, `$1"${projectSlug}"`);
}

/**
 * Run once after forking the template. Fail-closed by construction: every check runs before the
 * first write, so an invalid identity leaves the fork exactly as it was.
 */
export function bootstrapBrand({ rootDir }: BootstrapBrandOptions): BootstrapBrandSummary {
  const configPath = pathToFileURL(path.join(rootDir, "project.config.json"));
  const config = readProjectConfig(configPath);

  const envLocalPath = path.join(rootDir, ".env.local");
  if (existsSync(envLocalPath)) {
    throw new Error(
      `${envLocalPath} already exists; bootstrap:brand runs once on a fresh fork and never overwrites an existing environment file`,
    );
  }

  const envExamplePath = path.join(rootDir, ".env.example");
  if (!existsSync(envExamplePath)) {
    throw new Error(`${envExamplePath} is required to generate .env.local`);
  }
  const envLocal = renderEnvLocal(readFileSync(envExamplePath, "utf8"), config);

  const appDir = path.join(rootDir, "src", "app");
  const socialCardRoute = resolveSocialCardRoute(appDir, config.projectSlug);
  if (socialCardRoute.renamed && existsSync(path.join(appDir, socialCardRoute.to))) {
    throw new Error(
      `Cannot rename the social card route: ${path.join(appDir, socialCardRoute.to)} already exists`,
    );
  }

  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = rewritePackageName(
    readFileSync(packageJsonPath, "utf8"),
    config.projectSlug,
  );

  // Validation is complete; only now does anything change on disk.
  writeFileSync(envLocalPath, envLocal, { mode: 0o600 });
  if (socialCardRoute.renamed) {
    renameSync(path.join(appDir, socialCardRoute.from), path.join(appDir, socialCardRoute.to));
  }
  writeFileSync(packageJsonPath, packageJson);

  return {
    projectSlug: config.projectSlug,
    envLocalPath,
    socialCardRoute,
    packageName: config.projectSlug,
    manualChecklist: MANUAL_CHECKLIST,
  };
}
