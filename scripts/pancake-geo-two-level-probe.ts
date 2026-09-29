import { pathToFileURL } from "node:url";

import { loadCheckoutCommunes, loadCheckoutProvinces } from "../src/commerce/checkout-geo.ts";
import { PancakeClient } from "../src/integrations/pancake/client.ts";
import { readPancakeConfig } from "../src/integrations/pancake/config.ts";

/**
 * Read-only check that the live Pancake shop serves the post-2025 two-level address the checkout
 * now relies on: `is_new=true` provinces, and wards/communes listed straight under a new province
 * with no district. It goes through the exact checkout loaders, so a pass here means checkout's
 * strict parser accepts what Pancake really returns. Nothing is written to Pancake.
 *
 *   pnpm pancake:geo:probe                # first province
 *   pnpm pancake:geo:probe "Hà Nội"       # first province whose name contains the text
 */

const CI_REFUSAL_MESSAGE = "Trusted Pancake geo probe refuses CI execution";

function environmentFlagIsEnabled(value: string | undefined): boolean {
  return !(value === undefined || value === "" || value === "0" || value.toLowerCase() === "false");
}

async function runGeoProbe(): Promise<void> {
  if (environmentFlagIsEnabled(process.env.CI) || environmentFlagIsEnabled(process.env.GITHUB_ACTIONS)) {
    throw new Error(CI_REFUSAL_MESSAGE);
  }
  const wanted = process.argv[2]?.trim().toLocaleLowerCase("vi");
  const client = new PancakeClient({ apiKey: readPancakeConfig().apiKey });

  const provinces = await loadCheckoutProvinces(client);
  if (provinces.length === 0) throw new Error("Pancake returned no new-format provinces");
  const province = wanted
    ? provinces.find((candidate) => candidate.name.toLocaleLowerCase("vi").includes(wanted))
    : provinces[0];
  if (!province) throw new Error(`No new-format province name contains "${process.argv[2]}"`);

  const communes = await loadCheckoutCommunes(client, province.id);
  if (communes.length === 0) throw new Error(`Pancake returned no wards/communes for ${province.id}`);

  console.log("PANCAKE_GEO_TWO_LEVEL_PROBE_BEGIN");
  console.log(
    JSON.stringify(
      {
        provinces: provinces.length,
        sampleProvinces: provinces.slice(0, 5),
        province,
        communes: communes.length,
        sampleCommunes: communes.slice(0, 5),
      },
      null,
      2,
    ),
  );
  console.log("PANCAKE_GEO_TWO_LEVEL_PROBE_END");
  console.log(
    "OK: checkout can list new provinces and their wards/communes. Place one real COD test order before release to confirm Pancake accepts new_province_id / new_commune_id.",
  );
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  try {
    await runGeoProbe();
  } catch (error) {
    console.error(
      error instanceof Error ? `${error.name}: ${error.message}` : "Pancake geo probe failed",
    );
    process.exitCode = 1;
  }
}
