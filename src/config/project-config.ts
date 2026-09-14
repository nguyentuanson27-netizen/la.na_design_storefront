import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Project identity lives in one committed, non-secret file. Every other copy of these values —
 * CI environment, Compose project name, the database inside DATABASE_URL — is derived from it or
 * checked against it. Nothing here is a secret, and nothing secret may be added.
 */
export type ProjectConfig = Readonly<{
  projectSlug: string;
  databaseName: string;
  composeProjectName: string;
  productionDomain: string;
}>;

const PROJECT_CONFIG_FILE_LABEL = "project.config.json";

export const PROJECT_CONFIG_PATH = new URL(`../../${PROJECT_CONFIG_FILE_LABEL}`, import.meta.url);

type FieldRule = Readonly<{
  key: keyof ProjectConfig;
  pattern: RegExp;
  requirement: string;
}>;

const FIELD_RULES: readonly FieldRule[] = [
  {
    key: "projectSlug",
    pattern: /^[a-z][a-z0-9-]{1,29}[a-z0-9]$/,
    requirement:
      "3-31 characters, starting with a lowercase letter, ending with a lowercase letter or digit, and containing only lowercase letters, digits or hyphens",
  },
  {
    key: "databaseName",
    // PostgreSQL does not accept hyphens in an unquoted identifier.
    pattern: /^[a-z][a-z0-9_]{2,30}$/,
    requirement:
      "3-31 characters, starting with a lowercase letter, then lowercase letters, digits or underscores",
  },
  {
    key: "composeProjectName",
    // Docker Compose requires the project name to start with a lowercase letter or a digit.
    pattern: /^[a-z0-9][a-z0-9_-]{1,62}$/,
    requirement:
      "2-63 characters, starting with a lowercase letter or digit, then lowercase letters, digits, underscores or hyphens",
  },
  {
    key: "productionDomain",
    pattern: /^[a-z0-9.-]+\.[a-z]{2,}$/,
    requirement: "a bare lowercase hostname with no scheme, no path and no port",
  },
] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set(FIELD_RULES.map((rule) => rule.key));

function fail(message: string): never {
  throw new Error(`Invalid project identity: ${message}`);
}

/**
 * Fail-closed validation of an already-parsed identity document. Anything unexpected throws; no
 * value is guessed, defaulted or repaired.
 */
export function parseProjectConfig(raw: unknown): ProjectConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${PROJECT_CONFIG_FILE_LABEL} must be a JSON object`);
  }

  const document = raw as Record<string, unknown>;
  for (const key of Object.keys(document)) {
    if (!KNOWN_KEYS.has(key)) {
      fail(`unknown key "${key}"; only ${[...KNOWN_KEYS].join(", ")} are allowed`);
    }
  }

  const identity: Record<string, string> = {};
  for (const { key, pattern, requirement } of FIELD_RULES) {
    const value = document[key];
    if (typeof value !== "string") {
      fail(`${key} must be a string`);
    }
    if (!pattern.test(value)) {
      fail(`${key} must be ${requirement}`);
    }
    identity[key] = value;
  }

  return Object.freeze(identity as unknown as ProjectConfig);
}

/**
 * Reads the committed identity file. Plain JSON on purpose: no comment syntax, no parser
 * dependency, and `JSON.parse` is the only reader anything needs.
 */
export function readProjectConfig(configPath: URL = PROJECT_CONFIG_PATH): ProjectConfig {
  const path = fileURLToPath(configPath);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${PROJECT_CONFIG_FILE_LABEL} could not be read at ${path}: ${reason}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(contents) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `${PROJECT_CONFIG_FILE_LABEL} at ${path} is not valid JSON (plain JSON only, no comments): ${reason}`,
    );
  }

  return parseProjectConfig(document);
}
