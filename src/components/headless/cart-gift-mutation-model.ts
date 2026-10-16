/** A transport/lookup failure can happen after commit. Only readback can resolve it. */
export function giftMutationOutcome(result: { ok: boolean; reason?: string } | null): "saved" | "rejected" | "readback" {
  return !result || result.reason === "LOOKUP_FAILED" ? "readback" : result.ok ? "saved" : "rejected";
}
