"use client";

import { useState } from "react";

import { holdStorefrontVouchers } from "@/commerce/voucher-hold-actions";

/**
 * TEST HARNESS ONLY. Calls the REAL Server Action. It shows only the non-secret parts of the answer: the proof is
 * reduced to its length so nothing here can leak it into a page, a log or a trace.
 */
type Shown = { ok: boolean; reason?: string; state?: string; expiresAtMs?: number; totalPayableVnd?: number; proofLength?: number };

export function HoldButtons({ digest }: { digest: string }) {
  const [shown, setShown] = useState<Shown | null>(null);

  async function run(input: { expectedQuoteDigest: string; acknowledged?: boolean }) {
    const answer = (await holdStorefrontVouchers(input)) as Record<string, unknown>;
    setShown({
      ok: answer.ok === true,
      ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
      ...(typeof answer.state === "string" ? { state: answer.state } : {}),
      ...(typeof answer.expiresAtMs === "number" ? { expiresAtMs: answer.expiresAtMs } : {}),
      ...(typeof answer.totalPayableVnd === "number" ? { totalPayableVnd: answer.totalPayableVnd } : {}),
      ...(typeof answer.proof === "string" ? { proofLength: answer.proof.length } : {}),
    });
  }

  return (
    <div>
      <button type="button" data-testid="hold" onClick={() => void run({ expectedQuoteDigest: digest })}>
        Hold
      </button>
      <button type="button" data-testid="hold-ack" onClick={() => void run({ expectedQuoteDigest: digest, acknowledged: true })}>
        Hold (acknowledged)
      </button>
      <button type="button" data-testid="hold-stale" onClick={() => void run({ expectedQuoteDigest: "0".repeat(64) })}>
        Hold with a digest nobody was shown
      </button>
      <output data-testid="result">{shown === null ? "" : JSON.stringify(shown)}</output>
    </div>
  );
}
