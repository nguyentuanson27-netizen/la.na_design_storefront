# Google Flow virtual try-on operator runbook

This document is the deployment/operations companion to
[`storefront-virtual-try-on-flow-amendment.md`](../specs/storefront-virtual-try-on-flow-amendment.md).

Google Flow is an unofficial browser-automation provider in this integration. The storefront keeps
Vertex `virtual-try-on-001` as the manual rollback provider. Do not treat Flow as production-ready
until the live gates at the end of this document are recorded.

## Runtime shape

```text
shopper
  -> POST /api/try-on
  -> existing likeness/age/product/rate-limit gates
  -> app -> http://flow-worker:8787/v1/try-on
  -> gflow-cli 0.82.1
  -> real headed Google Chrome under Xvfb
  -> signed-in Google Flow account
```

The worker is on the private Compose `backend` network only. It is not published to the host or
public edge. It receives only Flow-specific environment variables; it does not inherit the
storefront database, auth, Pancake, email or other production secrets.

The app sends only the two already-approved images. Prompt and model policy are worker-owned.

## Model policy

Every request is:

1. Nano Banana Pro (`nano-pro`) first.
2. If and only if gflow reports a Nano Banana Pro **daily quota** exhaustion, retry exactly once with
   Nano Banana 2 (`nano2`).
3. Do not fall back on per-minute throttling, WAF/reCAPTCHA unusual activity, auth/session failures,
   safety/content refusal, timeout, selector drift, network failure or generic provider errors.
4. Never fall back automatically to Vertex, Nano Banana 2 Lite or a video model.

## Production environment

Keep the feature disabled while bootstrapping the Chrome session:

```dotenv
LA_TRY_ON_ENABLED=false
LA_TRY_ON_PROVIDER=flow
LA_TRY_ON_FLOW_URL=http://flow-worker:8787
LA_TRY_ON_FLOW_TOKEN=<at-least-32-random-characters>
LA_TRY_ON_FLOW_PROFILE=default
LA_TRY_ON_FLOW_PROJECT_ID=<optional-dedicated-flow-project-id>
```

Generate the worker token with a cryptographically secure source, for example:

```bash
openssl rand -hex 32
```

Do not reuse an application, database, Google credential or Better Auth secret.

## Build the worker before first enablement

From the repository root on the VPS:

```bash
docker compose \
  --env-file deploy/vps/.env.production \
  -f deploy/vps/compose.yml \
  --profile flow-try-on \
  build flow-worker
```

The image pins `gflow-cli==0.82.1`, installs real Google Chrome and runs generation headed under
Xvfb. Do not switch `GFLOW_CLI_HEADLESS=true`; that changes the browser mode gflow relies on for
Flow/reCAPTCHA.

## One-time Google login

The Chrome profile lives in the Compose volume `flow_gflow_data`. Treat that volume as a
credential: it contains a live Google session and must never be copied into Git, CI artifacts,
backups shared outside the production trust boundary, or logs.

The first login is interactive and needs a display that the container can reach. On a Linux host
with an X display, a typical bootstrap is:

```bash
xhost +local:
docker compose \
  --env-file deploy/vps/.env.production \
  -f deploy/vps/compose.yml \
  --profile flow-try-on \
  run --rm \
  -e DISPLAY="$DISPLAY" \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  flow-worker \
  gflow auth login --browser chrome --profile default
xhost -local:
```

If the VPS has no display reachable by the container, use an operator-controlled console/X11/VNC
path. Do not attempt to solve first login by switching gflow to headless mode.

After login, verify the saved session without exposing its output in deployment logs:

```bash
docker compose \
  --env-file deploy/vps/.env.production \
  -f deploy/vps/compose.yml \
  --profile flow-try-on \
  run --rm flow-worker \
  gflow auth status --profile default
```

The normal deploy script performs the same read-only live session check and refuses to call a Flow
deployment healthy when it fails.

## First-use Flow UI gate

Local reference uploads can encounter Google's one-time "rights to use this image" confirmation.
Before enabling shoppers, use the same Flow account manually, upload an operator-owned harmless test
image in Flow, and complete any required first-use confirmation yourself. The worker deliberately
does not click consent/rights confirmations on the operator's behalf.

A dedicated Flow project is recommended so operator review and future cleanup are scoped to try-on.
If `LA_TRY_ON_FLOW_PROJECT_ID` is empty, gflow may create projects while generating.

## Enable

Only after session verification and first-use setup:

```dotenv
LA_TRY_ON_ENABLED=true
LA_TRY_ON_PROVIDER=flow
```

Set `RELEASE_SHA` to the approved commit as usual and run the normal VPS deploy script. Production
Flow configuration must use `LA_TRY_ON_FLOW_URL=http://flow-worker:8787`.

When Flow is active, deploy:

1. builds the worker;
2. verifies the worker token shape and performs a read-only `gflow auth status` **before** database
   migration or app cutover;
3. after migration, starts the private worker and proves its Docker health/session again;
4. only then starts the new app/Caddy/catalog-sync release.

A dead Flow session therefore blocks cutover rather than exposing a broken Try-On entry point.

The worker accepts one generation at a time per Google profile. The storefront also reserves only
one Flow generation slot, so extra simultaneous calls fail `BUSY` before another large provider
request is sent. It never opens two Chrome generation runs against one profile.

## Failure semantics

The storefront exposes only existing safe try-on failure classes. Worker/Google error text, cookies,
profile paths, prompt output and CLI stdout/stderr are not returned to shoppers.

- `AUTH_FAILED`: session missing/expired or worker authentication failure.
- `BUSY`: profile already generating or upstream rate limit without proven Pro daily exhaustion.
- `SAFETY_BLOCKED`: content/safety refusal; final, no model fallback.
- `TIMEOUT`: generation watchdog expired.
- `GENERATION_FAILED`: all other provider/integration failures.

The worker's generation watchdog is shorter than the storefront's HTTP deadline so the worker
releases the profile lock before the caller gives up. On a watchdog expiry the worker terminates
the gflow/Chrome process group so an orphan browser cannot keep the profile locked. A timeout must
not trigger another model.

Worker logs are intentionally sparse: only safe event/model/failure-class metadata is emitted.
Prompts, image bytes, bearer tokens, Google cookies, account identifiers and raw provider error
detail are not logged.

## Privacy and retention

The storefront continues to avoid writing shopper/generated image bytes to Prisma, object storage,
analytics or its own durable filesystem. Worker input/output files live in a request-scoped temp
directory and are removed after the call.

That is **not** a zero-retention statement about Google Flow. Uploaded/generated media can appear in
Flow project/history semantics. This integration currently does not claim immediate deletion from
Google's systems. Buyer-facing privacy copy must reflect this before public enablement.

## Rollback

Fastest kill switch:

```dotenv
LA_TRY_ON_ENABLED=false
```

or switch the provider back to the existing Vertex integration:

```dotenv
LA_TRY_ON_PROVIDER=vertex
```

then restart/deploy the app with valid Vertex configuration.

The repository rollback script stops the current Flow worker before starting a previous storefront
release, so a signed-in Chrome worker is not left orphaned after rollback.

## Required live gates before public enablement

CI/offline tests cannot prove Google Flow's current private UI behavior. Record these against the
actual production-like Flow account/profile:

- [ ] `gflow auth status` verifies the saved session.
- [ ] One shopper + garment request succeeds on Nano Banana Pro.
- [ ] The returned file passes JPEG/PNG signature validation in the storefront.
- [ ] A real Pro daily-quota exhaustion is observed to return a model-named daily-quota error and
      causes exactly one Nano Banana 2 attempt.
- [ ] Per-minute throttling does not cause model fallback.
- [ ] Safety/content refusal does not cause model fallback.
- [ ] WAF/reCAPTCHA unusual activity does not cause model fallback.
- [ ] Worker timeout does not leave a second automatic generation running.
- [ ] Identity and garment fidelity are reviewed on representative áo dài/set/váy examples.
- [ ] The existing consented-minor acceptance case is re-run for Flow.
- [ ] Flow project/history behavior and buyer-facing privacy wording are approved.
- [ ] Operator confirms rollback to Vertex or feature-off works.
- [ ] Owner confirms use of unofficial Flow browser automation is acceptable for the Google account
      and operating context.

Until these are complete, keep `LA_TRY_ON_ENABLED=false` for public traffic.
