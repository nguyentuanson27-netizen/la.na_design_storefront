import { pathToFileURL } from "node:url";

import {
  AUTHORIZED_SHOP_ID,
  PancakeCapabilityProbeHarness,
  createProbeRunId,
  sanitizeSecrets,
} from "../src/integrations/pancake/capability-probe.ts";
import { PancakeClient } from "../src/integrations/pancake/client.ts";
import { readPancakeConfig } from "../src/integrations/pancake/config.ts";

const CI_REFUSAL_MESSAGE = "Trusted Pancake capability probe refuses CI execution";
const ROTATION_REFUSAL_MESSAGE =
  "PANCAKE_PROBE_CREDENTIAL_ROTATED=true is required before any Pancake probe network execution";

type ProbeEnvironment = Readonly<Record<string, string | undefined>>;

function flagEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function assertTrustedProbeEnvironment(env: ProbeEnvironment = process.env): void {
  if (flagEnabled(env.CI) || flagEnabled(env.GITHUB_ACTIONS)) {
    throw new Error(CI_REFUSAL_MESSAGE);
  }
  if (!flagEnabled(env.PANCAKE_PROBE_CREDENTIAL_ROTATED)) {
    throw new Error(ROTATION_REFUSAL_MESSAGE);
  }
}

export async function runCapabilityProbe(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  assertTrustedProbeEnvironment();
  const isExecute = args.includes("--execute");
  const config = readPancakeConfig();
  if (config.shopId !== AUTHORIZED_SHOP_ID) {
    throw new Error(
      `Shop ${config.shopId} is not authorized for capability probe; only ${AUTHORIZED_SHOP_ID} is authorized`,
    );
  }

  const harness = new PancakeCapabilityProbeHarness({
    client: new PancakeClient({ apiKey: config.apiKey }),
    isDryRun: !isExecute,
    runId: createProbeRunId(),
    onProgress: (message) => console.log(`[PROBE] ${message}`),
  });

  const results = await harness.runAllScenarios();
  console.log("PANCAKE_CAPABILITY_PROBE_BEGIN");
  console.log(
    JSON.stringify(
      {
        mode: isExecute ? "LIVE_EXECUTION" : "DRY_RUN",
        shopId: config.shopId,
        totalMutations: harness.mutationCount,
        trackedOrderIds: harness.trackedOrderIds,
        results,
      },
      null,
      2,
    ),
  );
  console.log("PANCAKE_CAPABILITY_PROBE_END");
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    await runCapabilityProbe();
  } catch (error) {
    console.error(
      `Pancake capability probe failed: ${sanitizeSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
  }
}
