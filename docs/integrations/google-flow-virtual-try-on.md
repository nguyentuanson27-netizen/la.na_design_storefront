# Google Flow virtual try-on operator runbook

This document is the deployment/operations companion to
[`storefront-virtual-try-on-flow-amendment.md`](../specs/storefront-virtual-try-on-flow-amendment.md).

Google Flow is an unofficial browser-automation provider in this integration. The storefront keeps
Vertex AI Nano Banana Pro (`gemini-3-pro-image`, see
[`vertex-virtual-try-on.md`](vertex-virtual-try-on.md)) as the manual rollback provider; the dedicated
`virtual-try-on-001` VTO model is no longer used. Do not treat Flow as production-ready
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

The image is intentionally reproducible at the credential-bearing boundary:

- Python is pinned to `python:3.13.14-slim` by image digest.
- The exact upstream `gflow-cli v0.82.1` `pyproject.toml` + `uv.lock` are checked in under
  `services/flow-worker/gflow-lock/`.
- The build exports that lock with `uv export --frozen`, installs the resolved runtime with
  `pip --require-hashes`, and pins the gflow 0.82.1 wheel by SHA-256.
- Google Chrome is pinned to `155.0.8059.39-1`; a missing apt version fails the build instead of
  silently moving the session-bearing worker to a new browser.

The worker runs real Chrome headed under Xvfb. Do not switch `GFLOW_CLI_HEADLESS=true`; that
changes the browser mode gflow relies on for Flow/reCAPTCHA.

Dependency/browser updates are deliberate maintenance work: replace the lock files from the exact
upstream gflow release tag, review the lock diff, update the gflow wheel hash and/or Chrome pin, run
CI image verification, then live-smoke one Flow generation before production rollout. Chrome is not
auto-upgraded just because Google's apt repository publishes a newer stable build.

## Chrome sandbox (accepted risk)

The worker image wraps `/opt/google/chrome/chrome` so every launch passes `--no-sandbox`. Chrome's
sandbox cannot start inside this container: its setuid helper is disabled by
`no-new-privileges`, and Docker's default seccomp profile blocks the unprivileged user namespaces
the namespace sandbox needs. Re-enabling it would mean either a custom seccomp profile that allows
user namespaces or giving up `no-new-privileges`, both of which widen the container boundary.

Without the sandbox, a Chrome renderer compromise runs with the full rights of the worker user.
That user can read the signed-in Google profile in `flow_gflow_data`, so such a compromise equals a
stolen Flow session. Chrome loads Google Flow pages; shopper photos are only uploaded as
references, after the worker validated their size and JPEG/PNG signature.

Compensating isolation (Dockerfile user, `deploy/vps/compose.yml` limits, operator account policy):

- non-root user (uid 10001) with `cap_drop: ALL` and `no-new-privileges`;
- `pids_limit` caps runaway process creation;
- the worker gets only its Flow variables, never `.env.production`, database or app secrets;
- the worker publishes no host port, joins only the private `backend` network (never `edge`) and
  requires a bearer token;
- the Google account used for the profile must be a dedicated Flow account, never a personal or
  Workspace admin account, so a stolen session exposes only Flow.

Revisit this decision when the VPS can run the worker with a seccomp profile that permits Chrome's
namespace sandbox; the wrapper is then removed and the CI image check keeps the Chrome pin.

## One-time Google login

The Chrome profile lives in the Compose volume `flow_gflow_data`. Treat that entire volume as
sensitive persistent browser state: it contains the live Google session and can also contain
Chrome-managed cookies, local storage, cache or other origin state. It must never be copied into
Git, CI artifacts, backups shared outside the production trust boundary, or logs.

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
  -e FLOW_WORKER_TOKEN= \
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
  run --rm \
  -e FLOW_WORKER_TOKEN= \
  flow-worker \
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

The worker runs gflow through `flow_worker.gflow_launcher`, which installs a prompt guard for the
gflow-cli 0.82.1 image-to-image path (`flow_worker/gflow_prompt_guard.py`). After both reference
mentions are attached it places the caret at the end of the composer, inserts `TRY_ON_PROMPT`, and
reads the composer back: the full prompt must be present and both mention chips kept, otherwise
the run fails before submit. The `ogiZ0b` submit is also aborted before it reaches Flow unless its
body carries both reference ids and the prompt. Either refusal is `GENERATION_FAILED` and never
falls back to another model. The guard refuses to load on any other gflow-cli version.

The worker's generation budget (120 s for the Pro attempt plus any Nano 2 fallback) is shorter than
the storefront's 130 s HTTP deadline so the worker releases the profile lock before the caller
gives up. On a watchdog expiry the worker terminates
the gflow/Chrome process group so an orphan browser cannot keep the profile locked. A timeout must
not trigger another model.

Worker logs are intentionally sparse: only safe event/model/failure-class metadata is emitted.
Prompts, image bytes, bearer tokens, Google cookies, account identifiers and raw provider error
detail are not logged.

## Privacy and retention

The storefront continues to avoid writing shopper/generated image bytes to Prisma, object storage,
analytics or its own durable filesystem. Worker input/output files live in a request-scoped temp
directory and are removed after the call.

gflow itself maintains a SQLite operation catalog. For generation commands the worker overrides
`GFLOW_CLI_DB_PATH` to `<request-temp>/gflow.db`, so gflow's operation/media IDs, prompt hashes,
generated-file path/hash/byte metadata and related provenance disappear with the same request temp
directory. Authentication/status commands default to a container-local `/tmp/gflow-auth.db`.
The gflow generation catalog therefore does not persist in `flow_gflow_data`. The volume still
contains the persistent Chrome user-data directory used by Playwright/gflow. Chrome can persist
browser-origin state there, so this integration does **not** claim that the volume contains only
authentication/session material or that shopper/generated media can never reach browser storage or
cache.

This is also **not** a zero-retention statement about Google Flow. Uploaded/generated media can
appear in Flow project/history semantics. Before public enablement, inspect the persistent profile
after representative live generations and approve an explicit retention/cleanup policy plus
buyer-facing privacy wording. Until that evidence exists, treat both Chrome browser storage and
Google Flow project/history as unresolved retention boundaries.

## Rollback

Fastest kill switch:

```dotenv
LA_TRY_ON_ENABLED=false
```

or switch the provider to the Vertex Nano Banana Pro rollback integration:

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
- [ ] Persistent Chrome profile is inspected after representative generation for browser-managed
      storage/cache behavior; retention/cleanup policy is approved.
- [ ] Flow project/history behavior and buyer-facing privacy wording are approved.
- [ ] Operator confirms rollback to Vertex or feature-off works.
- [ ] Owner confirms use of unofficial Flow browser automation is acceptable for the Google account
      and operating context.

Until these are complete, keep `LA_TRY_ON_ENABLED=false` for public traffic.
