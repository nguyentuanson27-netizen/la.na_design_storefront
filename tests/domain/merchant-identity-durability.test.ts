import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALLOWED_AUDIT_DATABASE_NAME,
  assertAuditDatabaseUrl,
  assertDurabilityEvidenceEnvironment,
  compareCatalogSnapshots,
  compareCorrelatedObservations,
  createCatalogIdSnapshot,
  type RawCorrelatedRunObservation,
} from "../../src/commerce/merchant-identity-durability.ts";
import { readProjectConfig } from "../../src/config/project-config.ts";

// The guard now derives the audit database from the committed project identity, so the fixtures
// that stand for "the real project database" derive from it too.
const PROJECT_DATABASE_NAME = readProjectConfig().databaseName;

test("creates well-formed snapshot with sorted hashed identifiers", () => {
  const snapshot = createCatalogIdSnapshot({
    runIndex: 1,
    timestamp: "2026-09-02T00:00:00.000Z",
    shopId: 1635185058,
    productExternalIds: ["prod-b", "prod-a"],
    variationExternalIds: ["var-2", "var-1"],
    internalVariantIdMap: { "var-1": "cuid-1", "var-2": "cuid-2" },
  });

  assert.equal(snapshot.runIndex, 1);
  assert.equal(snapshot.shopId, 1635185058);
  assert.deepEqual(snapshot.productExternalIds, ["prod-a", "prod-b"]);
  assert.deepEqual(snapshot.variationExternalIds, ["var-1", "var-2"]);
  assert.equal(typeof snapshot.productExternalIdsHash, "string");
  assert.equal(snapshot.productExternalIdsHash.length, 64);
  assert.equal(typeof snapshot.variationExternalIdsHash, "string");
  assert.equal(snapshot.variationExternalIdsHash.length, 64);
});

test("snapshot creator fails closed on malformed input", () => {
  assert.throws(
    () =>
      createCatalogIdSnapshot({
        runIndex: -1,
        timestamp: "2026-09-02",
        shopId: 123,
        productExternalIds: [],
        variationExternalIds: [],
      }),
    /runIndex must be a non-negative integer/i,
  );

  assert.throws(
    () =>
      createCatalogIdSnapshot({
        runIndex: 0,
        timestamp: "",
        shopId: 123,
        productExternalIds: [],
        variationExternalIds: [],
      }),
    /timestamp must be a non-empty string/i,
  );

  assert.throws(
    () =>
      createCatalogIdSnapshot({
        runIndex: 0,
        timestamp: "2026-09-02",
        shopId: 0,
        productExternalIds: [],
        variationExternalIds: [],
      }),
    /shopId must be a positive safe integer/i,
  );
});

test("comparison requires at least two snapshots and matching shop scope", () => {
  const snap1 = createCatalogIdSnapshot({
    runIndex: 0,
    timestamp: "2026-09-02T00:00:00Z",
    shopId: 100,
    productExternalIds: ["p1"],
    variationExternalIds: ["v1"],
  });

  assert.throws(() => compareCatalogSnapshots([snap1]), /at least two independent snapshots/i);

  const snapOtherShop = createCatalogIdSnapshot({
    runIndex: 1,
    timestamp: "2026-09-02T00:01:00Z",
    shopId: 200,
    productExternalIds: ["p1"],
    variationExternalIds: ["v1"],
  });

  assert.throws(
    () => compareCatalogSnapshots([snap1, snapOtherShop]),
    /must share the same shop scope/i,
  );
});

test("repeated identical runs prove stability with 100% match", () => {
  const products = ["p1", "p2", "p3"];
  const variations = ["v1", "v2", "v3", "v4"];
  const internalMap = { v1: "c1", v2: "c2", v3: "c3", v4: "c4" };

  const snap1 = createCatalogIdSnapshot({
    runIndex: 0,
    timestamp: "2026-09-02T00:00:00Z",
    shopId: 100,
    productExternalIds: products,
    variationExternalIds: variations,
    internalVariantIdMap: internalMap,
  });

  const snap2 = createCatalogIdSnapshot({
    runIndex: 1,
    timestamp: "2026-09-02T00:01:00Z",
    shopId: 100,
    productExternalIds: products,
    variationExternalIds: variations,
    internalVariantIdMap: internalMap,
  });

  const snap3 = createCatalogIdSnapshot({
    runIndex: 2,
    timestamp: "2026-09-02T00:02:00Z",
    shopId: 100,
    productExternalIds: products,
    variationExternalIds: variations,
    internalVariantIdMap: internalMap,
  });

  const comparison = compareCatalogSnapshots([snap1, snap2, snap3]);

  assert.equal(comparison.runsAudited, 3);
  assert.equal(comparison.identifierSetStableAcrossRuns, true);
  assert.equal(comparison.productStabilityPercent, 100);
  assert.equal(comparison.variationStabilityPercent, 100);
  assert.equal(comparison.disappearedProductIds.length, 0);
  assert.equal(comparison.appearedProductIds.length, 0);
  assert.equal(comparison.disappearedVariationIds.length, 0);
  assert.equal(comparison.appearedVariationIds.length, 0);
  assert.equal(comparison.duplicateProductIds.length, 0);
  assert.equal(comparison.duplicateVariationIds.length, 0);
  assert.equal(comparison.internalRowIdReplacedCount, 0);
  assert.equal(comparison.internalRowIdPreservedCount, 8); // 4 vars * 2 comparisons
});

test("changing or disappearing upstream IDs are detected and fail durability", () => {
  const snap1 = createCatalogIdSnapshot({
    runIndex: 0,
    timestamp: "2026-09-02T00:00:00Z",
    shopId: 100,
    productExternalIds: ["p1", "p2"],
    variationExternalIds: ["v1", "v2"],
  });

  // In run 2, v2 disappeared and v3 appeared (unexpected ID replacement)
  const snap2 = createCatalogIdSnapshot({
    runIndex: 1,
    timestamp: "2026-09-02T00:01:00Z",
    shopId: 100,
    productExternalIds: ["p1", "p2"],
    variationExternalIds: ["v1", "v3"],
  });

  const comparison = compareCatalogSnapshots([snap1, snap2]);

  assert.equal(comparison.identifierSetStableAcrossRuns, false);
  assert.deepEqual(comparison.disappearedVariationIds, ["v2"]);
  assert.deepEqual(comparison.appearedVariationIds, ["v3"]);
  assert.equal(comparison.variationStabilityPercent, 50);
});

test("internal row ID replacement fails durability", () => {
  const snap1 = createCatalogIdSnapshot({
    runIndex: 0,
    timestamp: "2026-09-02T00:00:00Z",
    shopId: 100,
    productExternalIds: ["p1"],
    variationExternalIds: ["v1"],
    internalVariantIdMap: { v1: "cuid-first" },
  });

  // Same external ID, but internal mirror row ID changed (mirror failed to reconcile by external ID)
  const snap2 = createCatalogIdSnapshot({
    runIndex: 1,
    timestamp: "2026-09-02T00:01:00Z",
    shopId: 100,
    productExternalIds: ["p1"],
    variationExternalIds: ["v1"],
    internalVariantIdMap: { v1: "cuid-second" },
  });

  const comparison = compareCatalogSnapshots([snap1, snap2]);

  assert.equal(comparison.identifierSetStableAcrossRuns, false);
  assert.equal(comparison.internalRowIdReplacedCount, 1);
});

test("trusted durability evidence script refuses CI before reading credentials", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/pancake-durability-evidence.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CI: "true", GITHUB_ACTIONS: "true" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /durability evidence script refuses CI execution/i);
});

test("durability evidence refuses production database name", () => {
  assert.throws(
    () =>
      assertAuditDatabaseUrl(`postgresql://user:pass@localhost:5432/${PROJECT_DATABASE_NAME}`),
    (err: unknown) => {
      assert(err instanceof Error);
      assert.match(
        err.message,
        new RegExp(`expected database '${ALLOWED_AUDIT_DATABASE_NAME}', got '${PROJECT_DATABASE_NAME}'`, "i"),
      );
      return true;
    },
  );
});

test("durability evidence allows exact approved audit database name", () => {
  const result = assertAuditDatabaseUrl(
    `postgresql://audit_user:secret@localhost:5432/${ALLOWED_AUDIT_DATABASE_NAME}?schema=public`,
  );
  assert.equal(result.databaseName, ALLOWED_AUDIT_DATABASE_NAME);
});

test("durability evidence refuses missing, empty, or malformed DATABASE_URL", () => {
  assert.throws(
    () => assertAuditDatabaseUrl(undefined),
    /DATABASE_URL is required to run durability evidence/i,
  );
  assert.throws(
    () => assertAuditDatabaseUrl("   "),
    /DATABASE_URL is required to run durability evidence/i,
  );
  assert.throws(
    () => assertAuditDatabaseUrl("not-a-valid-url"),
    /DATABASE_URL is malformed/i,
  );
  assert.throws(
    () => assertAuditDatabaseUrl("postgresql:///"),
    new RegExp(`expected database '${ALLOWED_AUDIT_DATABASE_NAME}', got ''`, "i"),
  );
});

test("durability evidence environment validator refuses CI before database validation", () => {
  assert.throws(
    () =>
      assertDurabilityEvidenceEnvironment({
        CI: "true",
        DATABASE_URL: `postgresql://user:pass@localhost:5432/${ALLOWED_AUDIT_DATABASE_NAME}`,
      }),
    /durability evidence script refuses CI execution/i,
  );
  assert.throws(
    () =>
      assertDurabilityEvidenceEnvironment({
        GITHUB_ACTIONS: "true",
        // Note: Even if DATABASE_URL is missing or invalid, CI check must trigger first!
        DATABASE_URL: undefined,
      }),
    /durability evidence script refuses CI execution/i,
  );
});

test("durability evidence error messages never leak passwords, hosts, or full URL secrets", () => {
  const sensitiveUrl =
    `postgresql://secret_user:super_secret_password_xyz987@prod-internal-db.example.com:5432/${PROJECT_DATABASE_NAME}?sslmode=require`;

  try {
    assertAuditDatabaseUrl(sensitiveUrl);
    assert.fail("assertAuditDatabaseUrl should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert.doesNotMatch(error.message, /secret_user/);
    assert.doesNotMatch(error.message, /super_secret_password_xyz987/);
    assert.doesNotMatch(error.message, /prod-internal-db\.example\.com/);
    assert.doesNotMatch(error.message, /sslmode/);
    assert.match(error.message, new RegExp(PROJECT_DATABASE_NAME));
  }

  // Also verify CLI stderr does not leak secrets when rejecting a production database
  const cliResult = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/pancake-durability-evidence.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "false",
        GITHUB_ACTIONS: "false",
        DATABASE_URL: sensitiveUrl,
      },
    },
  );
  assert.notEqual(cliResult.status, 0);
  assert.match(
    cliResult.stderr,
    new RegExp(`expected database '${ALLOWED_AUDIT_DATABASE_NAME}', got '${PROJECT_DATABASE_NAME}'`),
  );
  assert.doesNotMatch(cliResult.stderr, /secret_user/);
  assert.doesNotMatch(cliResult.stderr, /super_secret_password_xyz987/);
  assert.doesNotMatch(cliResult.stderr, /prod-internal-db\.example\.com/);
});

/**
 * The guard exists to stop a write-capable client from ever pointing at a database this run is not
 * allowed to touch. Refusing and *then* constructing one against that same `DATABASE_URL` gives away
 * most of what the refusal was for — a Prisma client is built from the connection string the guard
 * just rejected.
 *
 * `src/db/prisma.ts` builds its singleton at module scope and parks it on `globalThis` outside
 * production, so the absence of that global is a direct observation that no client was constructed,
 * rather than a proxy for it.
 */
test("a refused durability run constructs no Prisma client", async () => {
  const globalForPrisma = globalThis as { prisma?: unknown };
  const previous = globalForPrisma.prisma;
  delete globalForPrisma.prisma;

  // Both CI flags are cleared, not just one. The guard refuses CI *before* it looks at the database
  // name, so leaving GITHUB_ACTIONS set makes this assert the CI refusal instead of the one it is
  // about — which is exactly how it passed locally and failed on the runner.
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
  };
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:5432/${PROJECT_DATABASE_NAME}`;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;

  try {
    const { runDurabilityEvidence } = await import("../../scripts/pancake-durability-evidence.ts");

    await assert.rejects(
      () => runDurabilityEvidence({ runs: 1, delayMs: 0 }),
      /audit database/i,
      "a production database name must be refused",
    );

    assert.equal(
      globalForPrisma.prisma,
      undefined,
      "the refused run reached a Prisma client anyway",
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previous === undefined) delete globalForPrisma.prisma;
    else globalForPrisma.prisma = previous;
  }
});

/**
 * The behavioural test above cannot reach the CLI wrapper: its body only runs on direct execution,
 * and from outside the process a refusal that imports Prisma and one that does not are
 * indistinguishable — the client is built lazily, and the wrapper swallows the failure either way.
 *
 * So this half is deliberately structural. The property is structural too: the wrapper must not
 * import Prisma to clean up something the guard may have stopped from ever existing. Prisma's
 * lifecycle belongs inside the function, after the guard passes.
 */
test("the durability CLI wrapper does not import Prisma to clean up after a refusal", async () => {
  const source = await readFile(
    new URL("../../scripts/pancake-durability-evidence.ts", import.meta.url),
    "utf8",
  );

  const directExecutionBlock = source.slice(source.indexOf("if (isDirectExecution())"));
  assert.notEqual(directExecutionBlock, "", "the direct-execution block should still exist");
  assert.equal(
    directExecutionBlock.includes("db/prisma"),
    false,
    "the CLI wrapper must not import Prisma; the client's lifetime belongs to the guarded function",
  );

  const guardedFunction = source.slice(
    source.indexOf("export async function runDurabilityEvidence"),
    source.indexOf("function isDirectExecution"),
  );
  assert.equal(
    guardedFunction.includes("db/prisma"),
    true,
    "the guarded function owns the client it creates",
  );
  assert.equal(
    guardedFunction.includes("$disconnect"),
    true,
    "and disconnects it",
  );
});

/**
 * The comparison reads snapshots back from a mirror that reconciles products by `pancakeProductId`
 * and variations by `pancakeVariationId`. A stable identifier set, and a preserved internal row id
 * for a given external id, therefore follow from the upsert itself — they say the repository
 * reconciles by external id, which repository tests already establish.
 *
 * This fixture is the case the measurement is blind to: the provider remaps an identifier onto a
 * different object. The identifier set is untouched, the mirror writes the new data into the same
 * row, and every stability number still reads as perfect. Nothing in the result may call that proof
 * of upstream lifetime.
 */
test("identifier-set stability is never reported as proof of upstream lifetime", () => {
  const stable = compareCatalogSnapshots([
    createCatalogIdSnapshot({
      runIndex: 0,
      timestamp: "2026-09-01T00:00:00.000Z",
      shopId: 920_007,
      productExternalIds: ["p-1"],
      variationExternalIds: ["v-1"],
      internalVariantIdMap: { "v-1": "cuid-1" },
    }),
    createCatalogIdSnapshot({
      runIndex: 1,
      timestamp: "2026-09-01T00:00:01.000Z",
      shopId: 920_007,
      productExternalIds: ["p-1"],
      variationExternalIds: ["v-1"],
      // Same identifier, same mirror row — which is exactly what an upsert keyed by that identifier
      // guarantees, whether or not "v-1" still denotes the object it denoted a moment ago.
      internalVariantIdMap: { "v-1": "cuid-1" },
    }),
  ]);

  assert.equal(stable.identifierSetStableAcrossRuns, true, "the sets did hold across runs");
  assert.equal(
    stable.provesUpstreamLifetimeDurability,
    false,
    "and that is not evidence about upstream object lifetime",
  );
  assert.equal(
    Object.hasOwn(stable, "isDurable"),
    false,
    "no field may name this durability; the word is what caused the gate to be raised early",
  );
});

test("no arrangement of inputs can make the comparison claim upstream durability", () => {
  const snapshot = (runIndex: number, variationExternalIds: readonly string[]) =>
    createCatalogIdSnapshot({
      runIndex,
      timestamp: `2026-09-01T00:00:0${runIndex}.000Z`,
      shopId: 920_007,
      productExternalIds: ["p-1"],
      variationExternalIds: [...variationExternalIds],
      internalVariantIdMap: Object.fromEntries(
        variationExternalIds.map((id) => [id, `cuid-${id}`]),
      ),
    });

  for (const [label, second] of [
    ["identical runs", snapshot(1, ["v-1"])],
    ["a disappeared identifier", snapshot(1, [])],
    ["an appeared identifier", snapshot(1, ["v-1", "v-2"])],
  ] as const) {
    const comparison = compareCatalogSnapshots([snapshot(0, ["v-1"]), second]);
    assert.equal(
      comparison.provesUpstreamLifetimeDurability,
      false,
      `${label} must not flip the constant`,
    );
  }
});

function makeRunObservation({
  runIndex,
  phase = "TEST",
  productMarker = "M1-A132-P-test",
  pancakeProductId = "prod-a132",
  variations = [
    { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
    { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-m" },
    { variationMarker: "M1-A132-V-L-test", pancakeVariationId: "var-l" },
  ],
}: {
  runIndex: number;
  phase?: string;
  productMarker?: string;
  pancakeProductId?: string;
  variations?: { variationMarker: string; pancakeVariationId: string }[];
}): RawCorrelatedRunObservation {
  return {
    runIndex,
    phase,
    timestamp: new Date(1700000000000 + runIndex * 1000).toISOString(),
    totalCatalogEntries: 356,
    totalCatalogPages: 4,
    auditProduct: {
      productMarker,
      pancakeProductId,
      productName: "ÁO A132",
      variations,
    },
  };
}

test("compareCorrelatedObservations requires at least two independent run observations", () => {
  const singleRun = makeRunObservation({ runIndex: 0 });
  assert.throws(
    () => compareCorrelatedObservations([singleRun]),
    /at least two independent run observations/i,
  );
});

test("correlated comparison reports STABLE when all markers retain same IDs across runs", () => {
  const run0 = makeRunObservation({ runIndex: 0, phase: "T0_BASELINE" });
  const run1 = makeRunObservation({ runIndex: 1, phase: "T1_MUTATION" });
  const run2 = makeRunObservation({ runIndex: 2, phase: "T2_MUTATION" });

  const result = compareCorrelatedObservations([run0, run1, run2]);

  assert.equal(result.runsObserved, 3);
  assert.equal(result.verdict, "STABLE");
  assert.equal(result.allMarkersRetainedSameIds, true);
  assert.equal(result.productMarkerStable, true);
  assert.equal(result.variationMarkersStable, true);
  assert.equal(result.remapDetected, false);
  assert.equal(result.duplicateMarkersDetected, false);
  assert.equal(result.missingMarkersDetected, false);
  assert.equal(result.stableProductId, "prod-a132");
  assert.equal(result.variationResults.length, 3);
  assert.equal(result.variationResults[0]!.stableVariationId, "var-s");
});

test("remap blind spot: identical ID set across runs where markers swap IDs triggers REMAP_DETECTED", () => {
  // Run 0: S -> var-s, M -> var-m
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-m" },
    ],
  });

  // Run 1: S -> var-m, M -> var-s (SAME ID SET {var-s, var-m}, but IDs were swapped/remapped!)
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-m" },
      { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-s" },
    ],
  });

  const result = compareCorrelatedObservations([run0, run1]);

  assert.equal(result.verdict, "REMAP_DETECTED");
  assert.equal(result.remapDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
  assert.equal(result.variationMarkersStable, false);
});

test("correlated comparison detects changed product ID for same marker as REMAP_DETECTED", () => {
  const run0 = makeRunObservation({ runIndex: 0, pancakeProductId: "prod-1" });
  const run1 = makeRunObservation({ runIndex: 1, pancakeProductId: "prod-2" });

  const result = compareCorrelatedObservations([run0, run1]);

  assert.equal(result.verdict, "REMAP_DETECTED");
  assert.equal(result.productMarkerStable, false);
  assert.equal(result.remapDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});

test("correlated comparison detects changed variation ID for same marker as REMAP_DETECTED", () => {
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s-1" },
    ],
  });
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s-2" },
    ],
  });

  const result = compareCorrelatedObservations([run0, run1]);

  assert.equal(result.verdict, "REMAP_DETECTED");
  assert.equal(result.variationMarkersStable, false);
  assert.equal(result.remapDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});

test("correlated comparison fails closed on duplicate variation markers within a run", () => {
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-DUP", pancakeVariationId: "var-1" },
      { variationMarker: "M1-A132-V-DUP", pancakeVariationId: "var-2" },
    ],
  });
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-DUP", pancakeVariationId: "var-1" },
    ],
  });

  const result = compareCorrelatedObservations([run0, run1]);

  assert.equal(result.verdict, "DUPLICATE_MARKERS");
  assert.equal(result.duplicateMarkersDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});

test("correlated comparison fails closed on missing marker in subsequent run", () => {
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-m" },
    ],
  });
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      // M is missing!
    ],
  });

  const result = compareCorrelatedObservations([run0, run1]);

  assert.equal(result.verdict, "MISSING_MARKERS");
  assert.equal(result.missingMarkersDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});

test("correlated comparison fails closed when expected marker is missing already at T0", () => {
  // Expected 3 markers: S, M, L
  // But T0 and T1 only observed S and M
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-m" },
      // L is missing at T0!
    ],
  });
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-M-test", pancakeVariationId: "var-m" },
    ],
  });

  const result = compareCorrelatedObservations({
    expectedProductMarker: "M1-A132-P-test",
    expectedVariationMarkers: [
      "M1-A132-V-S-test",
      "M1-A132-V-M-test",
      "M1-A132-V-L-test",
    ],
    runs: [run0, run1],
  });

  assert.equal(result.verdict, "MISSING_MARKERS");
  assert.equal(result.missingMarkersDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});

test("correlated comparison fails closed on unexpected extra marker not in expected list", () => {
  const run0 = makeRunObservation({
    runIndex: 0,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-EXTRA", pancakeVariationId: "var-extra" },
    ],
  });
  const run1 = makeRunObservation({
    runIndex: 1,
    variations: [
      { variationMarker: "M1-A132-V-S-test", pancakeVariationId: "var-s" },
      { variationMarker: "M1-A132-V-EXTRA", pancakeVariationId: "var-extra" },
    ],
  });

  const result = compareCorrelatedObservations({
    expectedProductMarker: "M1-A132-P-test",
    expectedVariationMarkers: ["M1-A132-V-S-test"],
    runs: [run0, run1],
  });

  assert.equal(result.verdict, "UNEXPECTED_MARKERS");
  assert.equal(result.unexpectedMarkersDetected, true);
  assert.equal(result.allMarkersRetainedSameIds, false);
});


