# ADR 0012 — Contact-form outbound transport

- Status: **PROPOSE NEW PROVIDER — REQUIRES CHECKPOINT B APPROVAL**
- Date: 2026-09-16
- Scope: G3 design/evidence only. No provider account, key, dependency, DNS change, form action, or external send is created here.

## Context

`src/app/contact/page.tsx` explicitly leaves outbound delivery to G3/F9b. `package.json` has no mail/SMTP provider dependency. The repository already has a PostgreSQL `RateLimit` model and atomic server-side rate-limit implementations, so abuse control can reuse that pattern. The owner-approved customer support destination is the support email in Brand Config/master spec: `la.nadesignsince2022@gmail.com`.

## Decision

Use **Resend's HTTPS Email API via server-side `fetch`**, subject to Checkpoint B approval. No npm package is required; F9b should hide the HTTP call behind one narrow transport function.

### Official provider evidence — reviewed 2026-09-16

- Resend API Reference — **Introduction**: https://resend.com/docs/api-reference/introduction  
  REST API is HTTPS-only; authentication is `Authorization: Bearer <API key>`; standard response classes are `2xx` success, `4xx` caller/auth/rate failures, and `5xx` provider infrastructure failures. The current documented default team rate is 5 requests/second; `429` represents provider throttling.
- Resend — **Send Email**: https://resend.com/docs/api-reference/emails/send-email  
  `POST /emails` is the send boundary and returns an email `id` on documented success; it accepts an `Idempotency-Key` header.
- Resend — **Errors**: https://resend.com/docs/api-reference/errors  
  Provider failures have typed/status-coded responses including validation/auth/domain/rate-limit failures; F9b must classify them rather than return raw payloads to shoppers.
- Resend — **Idempotency Keys**: https://resend.com/docs/dashboard/emails/idempotency-keys  
  Send requests support keys up to 256 characters; the documented retention window is 24 hours and retries must use the same payload.
- Resend — **Managing Domains**: https://resend.com/docs/dashboard/domains/introduction  
  Production sending requires a domain the sender owns and provider DNS verification; Resend documents SPF and DKIM as the required verification records and recommends a sending subdomain to isolate reputation.
- Resend — **Send emails with Next.js**: https://resend.com/nextjs  
  Resend documents Next.js App Router / server-side integration, so the repository's Next.js server runtime is a supported integration shape.

The storefront's proposed rate limits below are intentionally much lower than the provider ceiling and exist for abuse control, not provider-capacity management. Provider responses are untrusted input; F9b may rely only on validated response fields/statuses.

## Transport contract

- **To:** existing Brand Config support inbox.
- **From:** a La.na-controlled sender identity on a verified La.na domain. The exact sender address is a Checkpoint B decision and is deliberately not invented here.
- **Reply-To:** validated customer email.
- Never use the customer-supplied address as `From`.

## Validation

Keep the minimal payload to `name`, `email`, `message` unless a later approved UI/spec adds more fields.

- reject non-object/array payloads and unsupported keys;
- `name`: required, trimmed, 1–100 code points;
- `email`: required, trimmed, syntactically valid, <=254 characters;
- `message`: required, trimmed, 1–4,000 code points;
- reject header-control characters in anything copied to headers;
- render user input as text, never trusted HTML.

Client validation is UX only; server validation is authoritative.

## Abuse protection

Reuse the existing DB-backed atomic rate-limit pattern. Initial F9b shape:

- pseudonymous client bucket: 3 attempts / 15 minutes;
- broader pseudonymous client bucket: 10 attempts / 24 hours;
- do not persist raw IP/email as the rate-limit key;
- consume the limit before the provider call;
- no client-only throttle and no CAPTCHA without later evidence.

## Security and failure semantics

- Provider credential stays server-only.
- Proposed secret name (name only): `RESEND_API_KEY`.
- Use a sending-only/domain-restricted provider key if the approved Resend account configuration supports it; least privilege is preferred over full account access.
- No secret in Brand Config, DB, browser bundle, form payload, logs, or shopper errors.
- Do not log message body, customer email/name, authorization headers, or raw provider errors.
- Success is returned only after the provider accepts the send with a validated documented success response and email id.
- Validation, rate-limit, network, or provider failures return bounded shopper-safe errors and never a fake sent state.
- F9b should use one idempotency identifier per logical submission; any automatic retry must reuse that identifier with the same payload within the documented 24-hour provider window. This ADR adds no queue/retry storage.

## Observability

Later emit a bounded `contact_form_delivery` event with outcome, correlation/request id, provider, and bounded status/error class. No ordinary-log PII or message content.

## Dependencies/configuration

- New npm package: **none**.
- Future server secret after approval: `RESEND_API_KEY`.
- DNS: verify the Checkpoint-B-approved La.na sender domain/identity before production use; SPF/DKIM changes are deployment-side work, not this PR.
- Destination remains the existing repository-owned Brand Config fact.

## Checkpoint B / F9b boundary

Checkpoint B must approve: Resend as a new external provider, exact sender identity/domain, required DNS changes, deployment secret creation/storage, submitted data boundary, and rate-limit shape.

Only after that may F9b implement the server handler/action, validation, limiter, provider transport, safe errors, idempotency and sanitized telemetry. Rollback is to disable/remove outbound form delivery while leaving the existing static support channels intact.

## Rejected alternatives

- Existing SMTP/provider reuse: none found in repository evidence.
- Add Resend SDK now: unnecessary and prohibited before approval; built-in server `fetch` suffices.
- Customer address as `From`: authentication/spoofing risk.
- Client-only throttling/CAPTCHA by default: not justified by current evidence.
- Local validation as success: not truthful delivery.