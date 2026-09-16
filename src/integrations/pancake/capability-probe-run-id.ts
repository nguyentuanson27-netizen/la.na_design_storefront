import { randomUUID } from "node:crypto";

export function createProbeRunId(): string {
  return randomUUID();
}
