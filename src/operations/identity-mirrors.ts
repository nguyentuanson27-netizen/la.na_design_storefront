import { extractDatabaseNameFromUrl } from "../commerce/merchant-identity-durability.ts";
import type { ProjectConfig } from "../config/project-config.ts";

/**
 * Non-secret project identity flows one way out of project.config.json, so most copies of it are
 * gone. Two cannot be: DATABASE_URL carries a password and therefore has to stay a secret with the
 * database name embedded in it, and COMPOSE_PROJECT_NAME reaches Docker through the environment.
 *
 * This is the preflight that keeps those unavoidable copies honest. A deployment that would write
 * another brand's database, or serve another brand's domain, stops here — before migrations run.
 */
export type IdentityMirrorInput = Readonly<{
  config: ProjectConfig;
  databaseUrl: string | undefined;
  appDomain: string | undefined;
  composeProject?: string | undefined;
  /**
   * Hosts this same project is already approved to serve besides its production domain. The legacy
   * temporary storefront origin is one: ADR 0004 approved it for this brand and ADR 0009 kept it
   * reachable for cutover and rollback, so refusing it here would block an approved deployment
   * rather than a cross-project mistake. The caller has to name them; nothing is inferred.
   */
  approvedLegacyDomains?: readonly string[];
}>;

export type IdentityMirrorSummary = Readonly<{
  databaseName: string;
  appDomainScope: "production" | "legacy" | "local";
  composeProjectChecked: boolean;
}>;

/**
 * The explicit local exception. Only loopback hosts are exempt from matching the production domain;
 * a hostname that merely reads as local ("local.example.vn") is not, and neither is a staging or
 * placeholder host. Production is never served from loopback, so this cannot widen a real deployment.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

function assertDatabaseMirror(databaseUrl: string | undefined, config: ProjectConfig): string {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL must be configured before deploying");
  }

  let databaseName: string;
  try {
    databaseName = extractDatabaseNameFromUrl(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (databaseName !== config.databaseName) {
    throw new Error(
      `DATABASE_URL points at database '${databaseName}' but project.config.json declares '${config.databaseName}'; refusing to deploy against another project's database`,
    );
  }

  return databaseName;
}

function assertAppDomainMirror(
  appDomain: string | undefined,
  config: ProjectConfig,
  approvedLegacyDomains: readonly string[],
): "production" | "legacy" | "local" {
  if (typeof appDomain !== "string" || appDomain.trim() === "") {
    throw new Error("APP_DOMAIN must be configured before deploying");
  }

  const [hostname = "", port] = appDomain.trim().toLowerCase().split(":");
  if (LOCAL_HOSTNAMES.has(hostname)) return "local";

  if (port !== undefined) {
    throw new Error(`APP_DOMAIN '${appDomain}' must not carry a port outside local development`);
  }
  if (hostname === config.productionDomain) return "production";
  if (approvedLegacyDomains.includes(hostname)) return "legacy";

  throw new Error(
    `APP_DOMAIN is '${appDomain}' but project.config.json declares production domain '${config.productionDomain}'; only loopback hosts and explicitly approved legacy hosts are exempt`,
  );
}

function assertComposeProjectMirror(
  composeProject: string | undefined,
  config: ProjectConfig,
): boolean {
  // Absent is not drift: outside Compose there is no second copy to disagree with. Compose itself
  // fails closed on an unset COMPOSE_PROJECT_NAME because compose.yml interpolates it as required.
  if (composeProject === undefined || composeProject === "") return false;

  if (composeProject !== config.composeProjectName) {
    throw new Error(
      `COMPOSE_PROJECT_NAME is '${composeProject}' but project.config.json declares '${config.composeProjectName}'`,
    );
  }

  return true;
}

export function assertIdentityMirrors({
  config,
  databaseUrl,
  appDomain,
  composeProject,
  approvedLegacyDomains = [],
}: IdentityMirrorInput): IdentityMirrorSummary {
  return {
    databaseName: assertDatabaseMirror(databaseUrl, config),
    appDomainScope: assertAppDomainMirror(appDomain, config, approvedLegacyDomains),
    composeProjectChecked: assertComposeProjectMirror(composeProject, config),
  };
}
