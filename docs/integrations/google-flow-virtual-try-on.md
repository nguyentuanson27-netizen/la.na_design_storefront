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
2. If the Pro attempt fails for **any quota, rate-limit or credit refusal**, retry exactly once with
   **Nano Banana 2.1** (released 2026-10-06). Owner decision: this deliberately includes refusals
   that do not say which limit ran out. The fallback signals are:
   - flow.google.com refuses the `ogiZ0b` image submit with gRPC `RESOURCE_EXHAUSTED`, with any
     reason or none (daily, per-minute or unspecified);
   - the image submit answers HTTP 429;
   - gflow's rate-limit error (exit 4), including per-minute limits;
   - Flow replaces the submit control with its insufficient-credits warning (gflow exit 37).

   The worker logs the refusal reasons as `quota_reasons` on `flow_try_on.process_error`.
3. Do not fall back on WAF/reCAPTCHA unusual activity, auth/session failures, safety/content
   refusal, timeout, selector drift, network failure or generic provider errors.
4. Never fall back automatically to Vertex, Nano Banana 2, Nano Banana 2 Lite or a video model.

gflow-cli 0.82.1 predates Nano Banana 2.1 and reports a quota refusal on flow.google.com as a generic
wire error, so the worker's gflow launcher patches both (`flow_worker/gflow_models.py`):

- The worker pins every gflow run to `GFLOW_CLI_FLOW_HOST=flow.google.com`, and the patches refuse to
  load under any other value. Only flow.google.com's composer carries these checks; on gflow's labs
  driver `nano2` is Nano Banana 2, so a labs route could never be reported as 2.1.
- gflow's `nano2` selects exactly the menu entry labelled "Nano Banana 2.1". Unpatched, it matches
  both "Nano Banana 2" and "Nano Banana 2.1" and fails as ambiguous.
- The model picker is read back after selection. A picker that does not show the requested model
  fails the run before any upload or submit.
- Nano Banana 2.1's wire key is not published. A 2.1 `ogiZ0b` body is accepted only when it carries
  the key configured in `LA_TRY_ON_FLOW_NANO_BANANA_2_1_MODEL_KEY` and no other image model key
  (`NARWHAL` = Nano Banana 2, Pro, 2 Lite, Imagen), plus both reference ids and the prompt. A
  configured value that is one of those other keys is ignored, which keeps the fallback disabled.
- **Live gate.** While that key is empty, every 2.1 submit is aborted before it reaches Flow, so
  the fallback does not generate. The aborted run logs `wire_model_candidates` on
  `flow_try_on.process_error`: the request's enum tokens only (no prompt, ids or tokens). Read the
  2.1 key from one such run (it is the token that replaces `GEM_PIX_2` compared with a Pro
  submit), confirm it is not `NARWHAL`, set it, and redeploy.
- A `RESOURCE_EXHAUSTED` submit refusal is reported with a quota marker the worker reads as "Pro
  quota exhausted". It is not reported as gflow's retried rate-limit error, so the request budget
  is not spent re-running Pro.

## Reference attach speed (`LA_TRY_ON_FLOW_MENTION_FAST`)

gflow-cli 0.82.1 attaches each reference by typing `@`, the file name and Enter, with fixed sleeps of
2.2 s, 2.5 s and 2.5 s in between (7.2 s per reference). The prompt guard
(`flow_worker/gflow_prompt_guard.py`) replaces those sleeps with waits on the page: the picker has
options, its first option is the typed asset (text ends with the name) and the list stayed unchanged
for 200 ms, then the chip exists. Every wait is capped at gflow's own sleep and falls through to
gflow's chip-count check and retry, so it is never slower than gflow. The submit body guard is
unchanged and still refuses a wrong or missing reference or prompt.

- **On by default.** Log event `tryon.mention_timing` (`picker_ms`, `type_ms`, `filter_wait_ms`,
  `commit_ms`, `filtered`) shows where the time goes. `filtered=false` on every run means Flow's
  picker rows do not look like the guard expects and the run took gflow's fixed time.
- **Rollback.** Set `LA_TRY_ON_FLOW_MENTION_FAST=0` (also `false`, `no`, `off`) in
  `deploy/vps/.env.production` and redeploy. `compose.yml` maps it to the worker's
  `FLOW_MENTION_FAST`; the worker passes it on to every gflow process, warm or not. Restoring it to
  `1` re-enables the fast path.

## Warm browser (optional)

By default every try-on starts its own gflow process, which launches Chrome and Flow's bootstrap
before any work begins. With `LA_TRY_ON_FLOW_WARM_BROWSER=true` the worker instead keeps one signed-in
Chrome open between requests. Design, limits and rationale:
[`flow-worker-warm-browser.md`](flow-worker-warm-browser.md). It is **off by default**; turn it on
only after the live gates below pass with it off.

How it behaves:

- A child process (`flow_worker.warm_child`) holds the browser; the worker talks to it over a pipe,
  so Chrome never sees `FLOW_WORKER_TOKEN`. One job at a time, as before.
- The browser starts on the first request, or earlier when the storefront calls `POST /v1/warm`
  (it does when a shopper with attempts left opens the dialog). It is released after
  `FLOW_WARM_IDLE_SECONDS` (30 min) without a request, and recycled between requests after
  `FLOW_WARM_MAX_JOBS` (50) jobs, `FLOW_WARM_MAX_AGE_SECONDS` (1 h) or when its process tree holds
  `FLOW_WARM_MAX_RSS_MB` (1200 MB). A failed job also recycles it.
- The container is capped at 1.5 GB (`mem_limit`) and 1.5 CPUs. Past the cap Docker restarts the
  worker, which comes back cold.
- If the warm browser cannot start, or dies before the image submit went out, that request is run
  the old way (own gflow process). A death after the submit is a failure, never a retry, so quota is
  not spent twice.
- `GET /health` adds `warm: {state, jobs, ageSeconds, idleSeconds, rssMb}`. Log events:
  `flow_warm.started` (with `startup_ms`), `flow_warm.stopped` (with `reason`), `flow_warm.start_failed`.

**While the browser is warm the worker holds the Chrome profile.** Anything else that opens that
profile (`gflow auth login`, `gflow auth status`, any `docker compose run ... gflow`) fails with a
profile-lock error. Release it first with `POST /v1/cool`:

```bash
docker compose --env-file deploy/vps/.env.production -f deploy/vps/compose.yml \
  --profile flow-try-on exec -T flow-worker python -c '
import os, urllib.request
request = urllib.request.Request(
    "http://127.0.0.1:8787/v1/cool", method="POST",
    headers={"authorization": "Bearer " + os.environ["FLOW_WORKER_TOKEN"]})
print(urllib.request.urlopen(request, timeout=30).read().decode())'
```

`200` means the browser is down **and the worker is closed to try-ons**: for
`FLOW_WARM_COOL_PAUSE_SECONDS` (15 min) no pre-warm hint starts Chrome and every `POST /v1/try-on` is
refused as `409 BUSY` (shoppers see the usual "busy, try again" message), so nothing else can take the
Chrome profile while the operator uses it. Cool also cancels a start that was already under way, and it
waits for a generation in flight (`409` until it ends). Do the operator work inside that window, then
call `POST /v1/resume` (same call, that path) to open the worker again, or let the pause run out.
If `FLOW_WARM_BROWSER` is off, none of this applies and the worker behaves as before.

`409 BUSY` means a generation is running, or the browser could not be released within 15 s: the
profile must **not** be assumed free. Retry in a few seconds.

`deploy.sh` does this itself around its `gflow auth status` checks. It skips a worker that is not
running or has no warm browser, retries on `409`, and **stops the deploy** if a running worker cannot
be cooled. It calls `POST /v1/resume` as soon as each check is over, whether it passed or failed, so
shoppers are refused (BUSY) only while a check needs the profile.

## Production environment

Keep the feature disabled while bootstrapping the Chrome session:

```dotenv
LA_TRY_ON_ENABLED=false
LA_TRY_ON_PROVIDER=flow
LA_TRY_ON_FLOW_URL=http://flow-worker:8787
LA_TRY_ON_FLOW_TOKEN=<at-least-32-random-characters>
LA_TRY_ON_FLOW_PROFILE=default
# Optional. Empty: the worker creates one "LA try-on" project on first use and reuses it.
LA_TRY_ON_FLOW_PROJECT_ID=
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

Every try-on generates in **one** Flow project. gflow creates a new scratch project for every
`image i2i` run that has no `--project`, so the worker never runs one without it:

- `LA_TRY_ON_FLOW_PROJECT_ID` set: that existing project is used.
- Empty: on the first generation the worker writes a pending marker to `try-on-project.json` in the
  `flow_gflow_data` volume, runs `gflow project create --title "LA try-on"` once, and replaces the
  marker with the id. Every later request, and every restarted or recreated worker, reuses it.
  Deleting that file (or the volume) is the only way the worker creates another project.
- Create at most once, fail closed: the pending marker is written **before** the create, so a worker
  that dies, times out or cannot record the id after Flow may have created the project never
  creates a second one, not even after a restart. Instead every request fails before generation
  with `flow_try_on.project_state_invalid` (`problem=pending`). The same happens when
  `try-on-project.json` cannot be read or holds no valid id. Only a create that failed before
  reaching Flow (no session, profile busy) withdraws the marker.
- To recover: find the "LA try-on" project in Flow (or the `project_id` logged by
  `flow_try_on.project_created` / `project_record_failed`), then write
  `{"projectId": "<id>"}` to `try-on-project.json` or set `LA_TRY_ON_FLOW_PROJECT_ID`.

Each run still uploads the shopper and garment under run-unique names, and the submit is aborted
unless it carries the two media ids this run uploaded, so one shared project cannot bind another
shopper's photo. The project does accumulate every upload and result; clean it up in Flow as part
of the retention review below.

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
- `BUSY`: profile already generating, or a rate limit that also hit the Nano Banana 2.1 fallback.
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
- [ ] A real Pro quota refusal (its `quota_reasons` recorded) causes exactly one Nano Banana 2.1
      attempt, with `LA_TRY_ON_FLOW_NANO_BANANA_2_1_MODEL_KEY` captured and set.
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
