import { createProbeRunId } from "./capability-probe-run-id.ts";
import {
  PancakeCapabilityProbeHarness as BasePancakeCapabilityProbeHarness,
  type ProbeHarnessOptions,
} from "./capability-probe-runner.ts";

export * from "./capability-probe-core.ts";
export * from "./capability-probe-targets.ts";
export * from "./capability-probe-writes.ts";
export * from "./capability-probe-run-id.ts";
export type { ProbeHarnessOptions } from "./capability-probe-runner.ts";

export class PancakeCapabilityProbeHarness extends BasePancakeCapabilityProbeHarness {
  constructor(options: ProbeHarnessOptions) {
    super({
      ...options,
      runId: options.runId ?? createProbeRunId(),
    });
  }
}
