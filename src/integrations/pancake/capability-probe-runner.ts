import {
  AUTHORIZED_SHOP_ID,
  MAX_RECONCILIATION_PAGES,
  RECONCILIATION_PAGE_SIZE,
  AmbiguousWriteError,
  CleanupFailureError,
  MutationTracker,
  assertConcurrencyAllowed,
  isRecord,
  sanitizeSecrets,
  type ProbeApiClient,
  type ProbeClassification,
  type ProbeScenarioResult,
  type ResolvedProbeTargets,
} from "./capability-probe-core.ts";
import {
  discoverAndValidateProbeTargets,
  fetchVariationStock,
} from "./capability-probe-targets.ts";
import {
  cancelProbeOrder,
  searchOrderByMarker,
  setVariationStockSafely,
  submitProbeOrder,
  type ProbeOrderSubmission,
} from "./capability-probe-writes.ts";

function classificationForSubmission(submission: ProbeOrderSubmission): ProbeClassification {
  if (submission.ambiguous || submission.writeCertainty === "AMBIGUOUS") return "AMBIGUOUS";
  if (submission.capabilityEvidence === "SUPPORTED") return "SUPPORTED";
  if (submission.capabilityEvidence === "UNSUPPORTED") return "UNSUPPORTED";
  return "NOT PROBED";
}

function dryRunResult(
  scenario: string,
  target: string,
  stock: number,
  notes: string,
): ProbeScenarioResult {
  return {
    scenario,
    target,
    initialStock: stock,
    submissions: 0,
    apiOutcome: "DRY_RUN",
    remoteOrderCreated: "no",
    finalStock: stock,
    stockDelta: 0,
    classification: "NOT PROBED",
    cleanup: "not-needed",
    notes: `DRY RUN ONLY: ${notes}. No remote orders or mutations executed.`,
  };
}

export type ProbeHarnessOptions = Readonly<{
  client: ProbeApiClient;
  isDryRun?: boolean;
  runId?: string;
  tracker?: MutationTracker;
  onProgress?: (message: string) => void;
}>;

export class PancakeCapabilityProbeHarness {
  private readonly client: ProbeApiClient;
  private readonly isDryRun: boolean;
  private readonly runId: string;
  private readonly tracker: MutationTracker;
  private readonly onProgress?: (message: string) => void;
  private targets?: ResolvedProbeTargets;
  private readonly baselines = new Map<string, number>();
  private readonly trackedOrders = new Set<string>();
  private readonly cleanedOrders = new Set<string>();
  private readonly attemptedMarkers = new Set<string>();

  constructor(options: ProbeHarnessOptions) {
    this.client = options.client;
    this.isDryRun = options.isDryRun ?? true;
    this.runId = options.runId ?? Date.now().toString(36).slice(-6);
    this.tracker = options.tracker ?? new MutationTracker();
    this.onProgress = options.onProgress;
  }

  get mutationCount(): number {
    return this.tracker.mutationCount;
  }

  get trackedOrderIds(): readonly string[] {
    return [...this.trackedOrders];
  }

  private progress(message: string): void {
    this.onProgress?.(message);
  }

  private async getTargets(): Promise<ResolvedProbeTargets> {
    if (!this.targets) {
      this.targets = await discoverAndValidateProbeTargets(this.client, AUTHORIZED_SHOP_ID);
    }
    return this.targets;
  }

  private async captureBaselines(): Promise<void> {
    const targets = await this.getTargets();
    this.baselines.clear();
    for (const variationId of targets.allowedVariationIds) {
      const stock = await fetchVariationStock(this.client, targets, variationId);
      this.baselines.set(variationId, stock.remainQuantity);
    }
  }

  private trackOrder(submission: ProbeOrderSubmission): void {
    this.attemptedMarkers.add(submission.marker);
    if (submission.orderId) this.trackedOrders.add(submission.orderId);
  }

  private async cancelTrackedOrder(orderId: string): Promise<void> {
    if (this.cleanedOrders.has(orderId)) return;
    await cancelProbeOrder(this.client, this.tracker, AUTHORIZED_SHOP_ID, orderId);
    this.cleanedOrders.add(orderId);
  }

  private async reconcileAttemptedMarkers(): Promise<void> {
    const failures: string[] = [];
    for (const marker of this.attemptedMarkers) {
      try {
        const found = await searchOrderByMarker(this.client, AUTHORIZED_SHOP_ID, marker);
        if (found.kind === "AMBIGUOUS") {
          failures.push(`Marker ${marker} could not be reconciled during cleanup: ${found.reason}`);
          continue;
        }
        if (found.kind === "FOUND") {
          this.trackedOrders.add(found.orderId);
          try {
            await this.cancelTrackedOrder(found.orderId);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      throw new CleanupFailureError(failures.map(sanitizeSecrets).join(" | "));
    }
  }

  private async restoreVariation(variationId: string): Promise<void> {
    const targets = await this.getTargets();
    const baseline = this.baselines.get(variationId);
    if (baseline === undefined) {
      throw new CleanupFailureError(`No baseline captured for variation ${variationId}`);
    }
    const target = [
      targets.ordinary,
      targets.compositeChildAo,
      targets.compositeChildVay,
    ].find((candidate) => candidate.variationId === variationId);
    if (!target) throw new CleanupFailureError(`Variation ${variationId} is not directly writable by the probe`);

    const result = await setVariationStockSafely(
      this.client,
      this.tracker,
      targets,
      variationId,
      target.warehouseId,
      baseline,
    );
    if (result.after !== baseline) {
      throw new CleanupFailureError(
        `Failed to restore ${variationId}: expected ${baseline}, observed ${result.after}`,
      );
    }
  }

  private async cleanupAll(): Promise<void> {
    if (this.isDryRun || !this.targets) return;
    const failures: string[] = [];

    try {
      await this.reconcileAttemptedMarkers();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    for (const orderId of this.trackedOrders) {
      try {
        await this.cancelTrackedOrder(orderId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    for (const variationId of [
      this.targets.ordinary.variationId,
      this.targets.compositeChildAo.variationId,
      this.targets.compositeChildVay.variationId,
    ]) {
      try {
        await this.restoreVariation(variationId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length > 0) {
      throw new CleanupFailureError(failures.map(sanitizeSecrets).join(" | "));
    }
  }

  async verifyFinalReconciliation(): Promise<void> {
    if (this.isDryRun) return;
    const targets = await this.getTargets();
    const failures: string[] = [];

    for (const variationId of targets.allowedVariationIds) {
      try {
        const expected = this.baselines.get(variationId);
        const current = (await fetchVariationStock(this.client, targets, variationId)).remainQuantity;
        if (expected === undefined || current !== expected) {
          failures.push(
            `Final stock mismatch for ${variationId}: expected ${String(expected)}, observed ${current}`,
          );
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      await this.reconcileAttemptedMarkers();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    for (const orderId of this.trackedOrders) {
      try {
        const raw = await this.client.getJson(`/shops/${targets.shopId}/orders/${orderId}`);
        const record = isRecord(raw) && isRecord(raw.data) ? raw.data : isRecord(raw) ? raw : null;
        if (record?.status !== 7) {
          failures.push(`Tracked probe order ${orderId} is not in terminal status 7`);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    const lateActiveOrders = new Set<string>();
    try {
      for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
        const raw = await this.client.getJson(`/shops/${targets.shopId}/orders`, {
          page_number: page,
          page_size: RECONCILIATION_PAGE_SIZE,
        });
        if (!isRecord(raw) || !Array.isArray(raw.data)) {
          throw new CleanupFailureError("Final marker sweep returned an invalid order-list payload");
        }
        for (const item of raw.data) {
          if (!isRecord(item)) continue;
          const note = typeof item.note === "string" ? item.note : "";
          if (!note.includes(`G2-PROBE-${this.runId}`) || item.status === 7) continue;
          if (item.id === undefined || item.id === null) {
            throw new CleanupFailureError("Final marker sweep found an active probe order without an id");
          }
          lateActiveOrders.add(String(item.id));
        }

        const totalPages = raw.total_pages;
        if (totalPages !== undefined && totalPages !== null) {
          if (!Number.isInteger(totalPages) || (totalPages as number) < page) {
            throw new CleanupFailureError(
              "Final marker sweep received invalid or contradictory pagination metadata",
            );
          }
          if (page >= (totalPages as number)) break;
          if (page === MAX_RECONCILIATION_PAGES) {
            throw new CleanupFailureError(
              "Final marker sweep exceeded the bounded reconciliation window; cleanup cannot be proven complete",
            );
          }
          continue;
        }

        if (raw.data.length < RECONCILIATION_PAGE_SIZE) break;
        if (page === MAX_RECONCILIATION_PAGES) {
          throw new CleanupFailureError(
            "Final marker sweep reached its bounded limit without authoritative pagination metadata",
          );
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    for (const orderId of lateActiveOrders) {
      this.trackedOrders.add(orderId);
      try {
        await this.cancelTrackedOrder(orderId);
        const raw = await this.client.getJson(`/shops/${targets.shopId}/orders/${orderId}`);
        const record = isRecord(raw) && isRecord(raw.data) ? raw.data : isRecord(raw) ? raw : null;
        if (record?.status !== 7) {
          failures.push(
            `Late-discovered probe order ${orderId} is not in terminal status 7 after cleanup`,
          );
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length > 0) {
      throw new CleanupFailureError(failures.map(sanitizeSecrets).join(" | "));
    }
  }

  private async runScenario0(): Promise<ProbeScenarioResult> {
    const targets = await this.getTargets();
    const target = targets.ordinary;
    const current = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (this.isDryRun) {
      return dryRunResult(
        "Scenario 0 — Control / Positive stock",
        target.displayId,
        current,
        "verified authorized target discovery and positive-control planning",
      );
    }

    let initialStock = current;
    if (current <= 0) {
      const prepared = await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        target.variationId,
        target.warehouseId,
        1,
      );
      if (prepared.after <= 0) {
        return {
          scenario: "Scenario 0 — Control / Positive stock",
          target: target.displayId,
          initialStock: current,
          submissions: 0,
          apiOutcome: "POSITIVE_PRECONDITION_NOT_ESTABLISHED",
          remoteOrderCreated: "no",
          finalStock: prepared.after,
          stockDelta: prepared.after - current,
          classification: "NOT PROBED",
          cleanup: "deferred",
          notes: "Positive-stock precondition could not be established safely; no order submitted.",
        };
      }
      initialStock = prepared.after;
    }

    const submission = await submitProbeOrder(
      this.client,
      this.tracker,
      targets,
      target.variationId,
      1,
      599_000,
      this.runId,
      "S0",
    );
    this.trackOrder(submission);
    if (submission.ambiguous) {
      throw new AmbiguousWriteError("Scenario 0 order submission could not be reconciled");
    }
    const finalStock = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (submission.orderId) await this.cancelTrackedOrder(submission.orderId);
    await this.restoreVariation(target.variationId);

    return {
      scenario: "Scenario 0 — Control / Positive stock",
      target: target.displayId,
      initialStock,
      submissions: 1,
      apiOutcome: submission.rawOutcome,
      remoteOrderCreated: submission.orderId ? "yes" : "no",
      finalStock,
      stockDelta: finalStock - initialStock,
      classification: classificationForSubmission(submission),
      cleanup: "restored",
      notes: "Positive-stock precondition was observed before the bounded order attempt.",
    };
  }

  private async runScenario1And2(): Promise<[ProbeScenarioResult, ProbeScenarioResult]> {
    const targets = await this.getTargets();
    const target = targets.ordinary;
    const current = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (this.isDryRun) {
      return [
        dryRunResult(
          "Scenario 1 — Exact Zero Stock",
          target.displayId,
          current,
          "verified zero-stock scenario planning",
        ),
        dryRunResult(
          "Scenario 2 — Already Negative Stock",
          target.displayId,
          current,
          "verified negative-stock chaining plan",
        ),
      ];
    }

    const zeroPrep = await setVariationStockSafely(
      this.client,
      this.tracker,
      targets,
      target.variationId,
      target.warehouseId,
      0,
    );
    if (zeroPrep.after !== 0) {
      return [
        {
          scenario: "Scenario 1 — Exact Zero Stock",
          target: target.displayId,
          initialStock: zeroPrep.before,
          submissions: 0,
          apiOutcome: "ZERO_PRECONDITION_NOT_ESTABLISHED",
          remoteOrderCreated: "no",
          finalStock: zeroPrep.after,
          stockDelta: zeroPrep.after - zeroPrep.before,
          classification: "NOT PROBED",
          cleanup: "deferred",
          notes: "Exact-zero precondition was not established safely.",
        },
        {
          scenario: "Scenario 2 — Already Negative Stock",
          target: target.displayId,
          initialStock: zeroPrep.after,
          submissions: 0,
          apiOutcome: "NOT_ESTABLISHED",
          remoteOrderCreated: "no",
          finalStock: zeroPrep.after,
          stockDelta: 0,
          classification: "NOT PROBED",
          cleanup: "deferred",
          notes: "Negative baseline was unavailable because Scenario 1 did not establish zero stock.",
        },
      ];
    }

    const s1Submission = await submitProbeOrder(
      this.client,
      this.tracker,
      targets,
      target.variationId,
      1,
      599_000,
      this.runId,
      "S1",
    );
    this.trackOrder(s1Submission);
    if (s1Submission.ambiguous) {
      throw new AmbiguousWriteError("Scenario 1 order submission could not be reconciled");
    }
    const afterS1 = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    const s1: ProbeScenarioResult = {
      scenario: "Scenario 1 — Exact Zero Stock",
      target: target.displayId,
      initialStock: 0,
      submissions: 1,
      apiOutcome: s1Submission.rawOutcome,
      remoteOrderCreated: s1Submission.orderId ? "yes" : "no",
      finalStock: afterS1,
      stockDelta: afterS1,
      classification: classificationForSubmission(s1Submission),
      cleanup: "deferred",
      notes: "Cleanup is intentionally deferred to Scenario 2 when Scenario 1 creates the negative starting state.",
    };

    if (!s1Submission.orderId || afterS1 >= 0) {
      if (s1Submission.orderId) await this.cancelTrackedOrder(s1Submission.orderId);
      await this.restoreVariation(target.variationId);
      return [
        { ...s1, cleanup: "restored" },
        {
          scenario: "Scenario 2 — Already Negative Stock",
          target: target.displayId,
          initialStock: afterS1,
          submissions: 0,
          apiOutcome: "NOT_ESTABLISHED",
          remoteOrderCreated: "no",
          finalStock: afterS1,
          stockDelta: 0,
          classification: "NOT PROBED",
          cleanup: "restored",
          notes: "Scenario 1 did not establish a negative starting state.",
        },
      ];
    }

    const s2Submission = await submitProbeOrder(
      this.client,
      this.tracker,
      targets,
      target.variationId,
      1,
      599_000,
      this.runId,
      "S2",
    );
    this.trackOrder(s2Submission);
    if (s2Submission.ambiguous) {
      throw new AmbiguousWriteError("Scenario 2 order submission could not be reconciled");
    }
    const afterS2 = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (s1Submission.orderId) await this.cancelTrackedOrder(s1Submission.orderId);
    if (s2Submission.orderId) await this.cancelTrackedOrder(s2Submission.orderId);
    await this.restoreVariation(target.variationId);

    return [
      s1,
      {
        scenario: "Scenario 2 — Already Negative Stock",
        target: target.displayId,
        initialStock: afterS1,
        submissions: 1,
        apiOutcome: s2Submission.rawOutcome,
        remoteOrderCreated: s2Submission.orderId ? "yes" : "no",
        finalStock: afterS2,
        stockDelta: afterS2 - afterS1,
        classification: classificationForSubmission(s2Submission),
        cleanup: "restored",
        notes: "Scenario 2 used the negative state created by Scenario 1; both tracked orders were independently cancelled and stock restored.",
      },
    ];
  }

  private async runScenario3(): Promise<ProbeScenarioResult> {
    const targets = await this.getTargets();
    const target = targets.ordinary;
    const current = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (this.isDryRun) {
      assertConcurrencyAllowed(2);
      return dryRunResult(
        "Scenario 3 — Boundary Concurrency",
        target.displayId,
        current,
        "verified concurrency ceiling 2 and boundary scenario planning",
      );
    }

    const prepared = await setVariationStockSafely(
      this.client,
      this.tracker,
      targets,
      target.variationId,
      target.warehouseId,
      0,
    );
    if (prepared.after !== 0) {
      return {
        scenario: "Scenario 3 — Boundary Concurrency",
        target: target.displayId,
        initialStock: prepared.before,
        submissions: 0,
        apiOutcome: "ZERO_PRECONDITION_NOT_ESTABLISHED",
        remoteOrderCreated: "no",
        finalStock: prepared.after,
        stockDelta: prepared.after - prepared.before,
        classification: "NOT PROBED",
        cleanup: "deferred",
        notes: "Concurrency scenario was not attempted because zero-stock precondition was not established.",
      };
    }

    assertConcurrencyAllowed(2);
    const [a, b] = await Promise.all([
      submitProbeOrder(
        this.client,
        this.tracker,
        targets,
        target.variationId,
        1,
        599_000,
        this.runId,
        "S3-A",
      ),
      submitProbeOrder(
        this.client,
        this.tracker,
        targets,
        target.variationId,
        1,
        599_000,
        this.runId,
        "S3-B",
      ),
    ]);
    this.trackOrder(a);
    this.trackOrder(b);
    if (a.ambiguous || b.ambiguous) {
      throw new AmbiguousWriteError("Scenario 3 contains an unreconciled concurrent order submission");
    }
    const finalStock = (await fetchVariationStock(this.client, targets, target.variationId)).remainQuantity;
    if (a.orderId) await this.cancelTrackedOrder(a.orderId);
    if (b.orderId) await this.cancelTrackedOrder(b.orderId);
    await this.restoreVariation(target.variationId);
    const accepted = Number(Boolean(a.orderId)) + Number(Boolean(b.orderId));
    const aClassification = classificationForSubmission(a);
    const bClassification = classificationForSubmission(b);
    const classification: ProbeClassification =
      aClassification === "SUPPORTED" && bClassification === "SUPPORTED"
        ? "SUPPORTED"
        : aClassification === "UNSUPPORTED" && bClassification === "UNSUPPORTED"
          ? "UNSUPPORTED"
          : aClassification === "NOT PROBED" && bClassification === "NOT PROBED"
            ? "NOT PROBED"
            : "AMBIGUOUS";

    return {
      scenario: "Scenario 3 — Boundary Concurrency",
      target: target.displayId,
      initialStock: 0,
      submissions: 2,
      apiOutcome: `A=${a.rawOutcome}; B=${b.rawOutcome}`,
      remoteOrderCreated: accepted > 0 ? "yes" : "no",
      finalStock,
      stockDelta: finalStock,
      classification,
      cleanup: "restored",
      notes: `Bounded concurrency test used exactly two submissions; ${accepted}/2 produced tracked orders.`,
    };
  }

  private async runCompositeScenario(
    scenario: "S4" | "S5" | "S6",
  ): Promise<ProbeScenarioResult> {
    const targets = await this.getTargets();
    const parent = targets.compositeParent;
    const ao = targets.compositeChildAo;
    const vay = targets.compositeChildVay;
    const parentStock = (await fetchVariationStock(this.client, targets, parent.variationId)).remainQuantity;
    const labels = {
      S4: "Scenario 4 — Composite Positive",
      S5: "Scenario 5 — Composite Component at Zero",
      S6: "Scenario 6 — Composite Component Negative",
    } as const;

    if (this.isDryRun) {
      return dryRunResult(
        labels[scenario],
        parent.displayId,
        parentStock,
        "verified exact 1:1 component relationship and scenario planning",
      );
    }

    if (scenario === "S4") {
      await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        ao.variationId,
        ao.warehouseId,
        1,
      );
      await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        vay.variationId,
        vay.warehouseId,
        1,
      );
    } else if (scenario === "S5") {
      await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        ao.variationId,
        ao.warehouseId,
        0,
      );
      await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        vay.variationId,
        vay.warehouseId,
        1,
      );
    } else {
      if (this.tracker.remaining < 6) {
        return {
          scenario: labels[scenario],
          target: parent.displayId,
          initialStock: parentStock,
          submissions: 0,
          apiOutcome: "MUTATION_BUDGET_RESERVED_FOR_CLEANUP",
          remoteOrderCreated: "no",
          finalStock: parentStock,
          stockDelta: 0,
          classification: "NOT PROBED",
          cleanup: "not-needed",
          notes: "Scenario 6 was skipped to preserve the hard mutation budget and cleanup capacity.",
        };
      }
      const negative = await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        ao.variationId,
        ao.warehouseId,
        -1,
      );
      if (negative.after >= 0) {
        await this.restoreVariation(ao.variationId);
        await this.restoreVariation(vay.variationId);
        return {
          scenario: labels[scenario],
          target: parent.displayId,
          initialStock: parentStock,
          submissions: 0,
          apiOutcome: "NOT_ESTABLISHED",
          remoteOrderCreated: "no",
          finalStock: parentStock,
          stockDelta: 0,
          classification: "NOT PROBED",
          cleanup: "restored",
          notes: "Negative component baseline could not be established safely; no parent order was submitted.",
        };
      }
      await setVariationStockSafely(
        this.client,
        this.tracker,
        targets,
        vay.variationId,
        vay.warehouseId,
        1,
      );
    }

    const initialParent = (await fetchVariationStock(this.client, targets, parent.variationId)).remainQuantity;
    const initialAo = (await fetchVariationStock(this.client, targets, ao.variationId)).remainQuantity;
    const initialVay = (await fetchVariationStock(this.client, targets, vay.variationId)).remainQuantity;
    const submission = await submitProbeOrder(
      this.client,
      this.tracker,
      targets,
      parent.variationId,
      1,
      649_000,
      this.runId,
      scenario,
    );
    this.trackOrder(submission);
    if (submission.ambiguous) {
      throw new AmbiguousWriteError(`${labels[scenario]} order submission could not be reconciled`);
    }
    const finalParent = (await fetchVariationStock(this.client, targets, parent.variationId)).remainQuantity;
    const finalAo = (await fetchVariationStock(this.client, targets, ao.variationId)).remainQuantity;
    const finalVay = (await fetchVariationStock(this.client, targets, vay.variationId)).remainQuantity;
    if (submission.orderId) await this.cancelTrackedOrder(submission.orderId);
    await this.restoreVariation(ao.variationId);
    await this.restoreVariation(vay.variationId);

    return {
      scenario: labels[scenario],
      target: parent.displayId,
      initialStock: initialParent,
      submissions: 1,
      apiOutcome: submission.rawOutcome,
      remoteOrderCreated: submission.orderId ? "yes" : "no",
      finalStock: finalParent,
      stockDelta: finalParent - initialParent,
      componentDeltas: {
        [ao.displayId]: finalAo - initialAo,
        [vay.displayId]: finalVay - initialVay,
      },
      classification: classificationForSubmission(submission),
      cleanup: "restored",
      notes:
        scenario === "S6"
          ? "Negative-component behavior is only evidence when the negative precondition was actually established in this run."
          : "Observed result applies only to the authorized two-component 1:1 fixture.",
    };
  }

  async runAllScenarios(): Promise<ProbeScenarioResult[]> {
    await this.getTargets();
    await this.captureBaselines();
    const results: ProbeScenarioResult[] = [];
    let primaryError: unknown;

    try {
      this.progress("Scenario 0");
      results.push(await this.runScenario0());
      this.progress("Scenarios 1-2");
      const [s1, s2] = await this.runScenario1And2();
      results.push(s1, s2);
      this.progress("Scenario 3");
      results.push(await this.runScenario3());
      this.progress("Scenario 4");
      results.push(await this.runCompositeScenario("S4"));
      this.progress("Scenario 5");
      results.push(await this.runCompositeScenario("S5"));
      this.progress("Scenario 6");
      results.push(await this.runCompositeScenario("S6"));
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try {
      await this.cleanupAll();
    } catch (error) {
      cleanupError = error;
    }

    let finalReconciliationError: unknown;
    try {
      await this.verifyFinalReconciliation();
    } catch (error) {
      finalReconciliationError = error;
    }

    const failures = [primaryError, cleanupError, finalReconciliationError].filter(
      (error): error is NonNullable<typeof error> => error !== undefined && error !== null,
    );
    if (failures.length > 1) {
      throw new AggregateError(failures, "Probe execution and cleanup/reconciliation reported failures");
    }
    if (failures.length === 1) throw failures[0];
    return results;
  }
}
