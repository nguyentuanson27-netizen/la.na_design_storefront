import {
  CSP_REPORT_CONTENT_TYPES,
  CSP_REPORT_MAX_BYTES,
  createCspReportLogGate,
  parseCspReport,
} from "@/security/csp-report";

const admit = createCspReportLogGate();

/**
 * Where browsers report Content-Security-Policy violations (`report-uri` in the per-request script
 * policy, src/security/script-nonce-policy.ts). Each violation becomes one bounded JSON log line;
 * the response is always an empty 204, so a caller learns nothing from it.
 */
export async function POST(request: Request): Promise<Response> {
  const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  try {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!CSP_REPORT_CONTENT_TYPES.has(contentType)) return empty();
    if (Number(request.headers.get("content-length") ?? 0) > CSP_REPORT_MAX_BYTES) return empty();

    // Bound the bytes actually read too: a missing or lying Content-Length does not bypass this.
    const reader = request.body?.getReader();
    if (!reader) return empty();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CSP_REPORT_MAX_BYTES) {
        await reader.cancel();
        return empty();
      }
      chunks.push(value);
    }

    for (const violation of parseCspReport(JSON.parse(Buffer.concat(chunks).toString("utf8")))) {
      const gate = admit(Date.now());
      if (gate.suppressedInPreviousWindow > 0) {
        console.warn(JSON.stringify({ name: "csp.violation_suppressed", count: gate.suppressedInPreviousWindow }));
      }
      if (gate.log) console.warn(JSON.stringify({ name: "csp.violation", ...violation }));
    }
  } catch {
    // A malformed report is the sender's problem; it never becomes an error here.
  }
  return empty();
}
