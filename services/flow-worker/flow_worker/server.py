from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .policy import QUOTA_EXHAUSTED_MARKER, is_flow_quota_refusal, should_fallback_from_pro
from .warm import WarmConfig, WarmRunner, spawn_child

HOST = os.environ.get("FLOW_WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLOW_WORKER_PORT", "8787"))
TOKEN = os.environ.get("FLOW_WORKER_TOKEN", "")
PROFILE = os.environ.get("GFLOW_CLI_PROFILE", "default")
GFLOW_HOME = Path(os.environ.get("GFLOW_CLI_HOME", "/data/gflow"))
PROJECT_ID = os.environ.get("FLOW_PROJECT_ID", "").strip()
GENERATION_BUDGET_SECONDS = int(os.environ.get("FLOW_COMMAND_TIMEOUT_SECONDS", "120"))
REQUEST_READ_TIMEOUT_SECONDS = int(os.environ.get("FLOW_REQUEST_READ_TIMEOUT_SECONDS", "15"))


def _env_number(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


# Keep one signed-in Chrome warm between requests (see flow_worker.warm). Off unless asked for.
WARM_BROWSER = os.environ.get("FLOW_WARM_BROWSER", "").strip().lower() in ("1", "true", "yes")
WARM_CONFIG = WarmConfig(
    idle_seconds=_env_number("FLOW_WARM_IDLE_SECONDS", 1800),
    max_jobs=int(_env_number("FLOW_WARM_MAX_JOBS", 50)),
    max_age_seconds=_env_number("FLOW_WARM_MAX_AGE_SECONDS", 3600),
    max_rss_mb=int(_env_number("FLOW_WARM_MAX_RSS_MB", 1200)),
    start_timeout_seconds=_env_number("FLOW_WARM_START_TIMEOUT_SECONDS", 90),
    min_restart_seconds=_env_number("FLOW_WARM_MIN_RESTART_SECONDS", 60),
)
WARM_MAINTENANCE_SECONDS = 5.0

MAX_IMAGE_BYTES = 7 * 1024 * 1024
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_ERROR_DETAIL_CHARS = 4 * 1024
WORKER_TIMEOUT_EXIT_CODE = 124
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# gflow-cli 0.82.1's --project allowlist.
PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,128}$")
PROJECT_TITLE = "LA try-on"
REQUIRED_FLOW_HOST = "flow.google.com"
PROJECT_STATE_FILE = "try-on-project.json"
WORKER_ROOT = Path(__file__).resolve().parent.parent

TRY_ON_PROMPT = """Use the first reference image as the person and the second reference image as the garment.
Dress the person naturally in the exact referenced garment.
Preserve the person's face, identity, apparent age, pose, body proportions, skin tone, hair and framing.
Preserve the garment's silhouette, color, pattern, fabric appearance, embroidery and visible design details.
Do not add unrelated clothing or accessories. Do not alter body shape. Do not sexualize the subject.
Produce one realistic, age-appropriate fashion try-on image."""

_generation_lock = threading.Lock()
# The clock a request's deadline is measured on; a seam so tests can move time.
_monotonic = time.monotonic
# The warm browser, when FLOW_WARM_BROWSER is on (created in main()); None means every request starts
# gflow as its own process, as before.
_warm_runner: WarmRunner | None = None
# The one Flow project every try-on generates in: LA_TRY_ON_FLOW_PROJECT_ID, else the project this
# worker created once and recorded in the gflow volume. gflow creates a scratch project for every
# i2i run without --project, so no generation may start until this is known.
_project_id: str | None = PROJECT_ID or None
# A project this worker created but could not record yet; retried instead of creating another.
_unrecorded_project_id: str | None = None


class RequestError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class GflowMachineError:
    detail: str = ""
    error_class: str = ""
    problem_type: str = ""


def _event(name: str, **fields: str) -> None:
    """Emit only bounded operational metadata; never prompts, bytes, tokens or provider detail."""
    print(json.dumps({"event": name, **fields}, separators=(",", ":")), flush=True)


def _sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return None


def _decode_image(value: Any) -> tuple[bytes, str]:
    if not isinstance(value, dict):
        raise RequestError("invalid image object")
    if set(value) != {"mimeType", "imageBase64"}:
        raise RequestError("invalid image fields")
    mime = value.get("mimeType")
    encoded = value.get("imageBase64")
    if mime not in ("image/jpeg", "image/png") or not isinstance(encoded, str):
        raise RequestError("unsupported image")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise RequestError("invalid base64") from exc
    if not data or len(data) > MAX_IMAGE_BYTES or _sniff_mime(data) != mime:
        raise RequestError("invalid image bytes")
    return data, mime


def _profile_dir() -> Path | None:
    if PROFILE_PATTERN.fullmatch(PROFILE) is None:
        return None
    return GFLOW_HOME / f"profile_{PROFILE}"


def _profile_present() -> bool:
    profile_dir = _profile_dir()
    return profile_dir is not None and profile_dir.is_dir()


def _gflow(*args: str) -> list[str]:
    # The launcher runs the gflow CLI with the try-on patches installed (see gflow_launcher).
    return [sys.executable, "-m", "flow_worker.gflow_launcher", *args]


def _command(model: str, person: Path, product: Path, output: Path) -> list[str]:
    if _project_id is None:
        raise ValueError("the try-on Flow project is not resolved")
    return _gflow(
        "image",
        "i2i",
        TRY_ON_PROMPT,
        "--ref",
        str(person),
        "--ref",
        str(product),
        "--model",
        model,
        "--aspect",
        "3:4",
        "--count",
        "1",
        "--profile",
        PROFILE,
        "--output",
        str(output),
        "--project",
        _project_id,
        "--json",
    )


def _machine_error(stdout: str) -> GflowMachineError:
    """Parse only gflow's stable --json error envelope; never scrape human/log stderr."""
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return GflowMachineError()
    if not isinstance(payload, dict) or payload.get("status") != "fail":
        return GflowMachineError()
    error = payload.get("error")
    if not isinstance(error, dict):
        return GflowMachineError()

    detail = error.get("detail")
    error_class = error.get("class")
    problem_type = error.get("type")
    return GflowMachineError(
        detail=detail[:MAX_ERROR_DETAIL_CHARS] if isinstance(detail, str) else "",
        error_class=error_class if isinstance(error_class, str) else "",
        problem_type=problem_type if isinstance(problem_type, str) else "",
    )


def _gflow_env(db_path: Path) -> dict[str, str]:
    env = dict(os.environ)
    # The worker bearer token authenticates storefront -> worker only. gflow/Chrome never need it.
    env.pop("FLOW_WORKER_TOKEN", None)
    env["DISPLAY"] = os.environ.get("DISPLAY", ":99")
    env["GFLOW_CLI_HEADLESS"] = "false"
    env["GFLOW_CLI_HISTORY_PROMPTS"] = "redacted"
    env["GFLOW_CLI_UPDATE_CHECK"] = "false"
    # Only flow.google.com's composer carries the try-on patches (prompt guard, Nano Banana 2.1
    # selection and wire check). On gflow's labs driver `nano2` is Nano Banana 2, so a labs route
    # must be impossible: gflow_models refuses to load under any other host setting.
    env["GFLOW_CLI_FLOW_HOST"] = REQUIRED_FLOW_HOST
    env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(WORKER_ROOT), env.get("PYTHONPATH"))))
    # gflow records every generation in a local SQLite catalog. Keep that catalog inside the
    # request tempdir so operation/media IDs, hashes, local paths and byte counts disappear with
    # the request instead of landing beside the persistent signed-in Chrome profile.
    env["GFLOW_CLI_DB_PATH"] = str(db_path)
    return env


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    """Best-effort cleanup for gflow plus Chrome descendants after the watchdog expires."""
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except OSError:
        return
    try:
        process.wait(timeout=2)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return


# Chrome's ProcessSingleton artifacts. Each is a symlink: SingletonLock -> "<hostname>-<pid>",
# SingletonCookie -> random token, SingletonSocket -> socket under the creating container's /tmp.
CHROME_SINGLETON_NAMES = ("SingletonLock", "SingletonCookie", "SingletonSocket")


def _chrome_uses_profile(profile_dir: Path) -> bool:
    """True when any process in this PID namespace runs Chrome on *profile_dir*.

    Fails closed: without a readable /proc nothing can be proven, so the profile counts as in use.
    """
    proc = Path("/proc")
    if not proc.is_dir():
        return True
    targets = {str(profile_dir), str(profile_dir.resolve())}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        for arg in argv:
            if arg.startswith(b"--user-data-dir=") and arg[16:].decode(errors="replace") in targets:
                return True
    return False


def _acquire_profile_lease(profile_dir: Path) -> Any | None:
    """Take gflow's own cross-process profile lease (flock under GFLOW_CLI_HOME/locks).

    Every gflow command holds this lease for as long as it drives Chrome, from this container or
    from a one-off `compose run` sharing the volume. Returns None when it is held or unavailable.
    """
    try:
        from gflow_cli.profile_lease import ProfileLease
    except ImportError:
        return None
    lease = ProfileLease(profile_dir)
    try:
        return lease if lease.try_acquire() else None
    except Exception:
        return None


def _clean_stale_profile_locks() -> None:
    """Remove Chrome singleton links left by a Chrome that no longer exists.

    A recreated container gets a new hostname, and Chrome refuses a SingletonLock naming another
    host even when that Chrome is long dead. The links are removed only while (1) the profile name
    is valid, (2) this process holds gflow's profile lease, so no gflow run anywhere is using the
    profile, and (3) no Chrome in this container still runs on the profile directory.
    """
    profile_dir = _profile_dir()
    if profile_dir is None or not profile_dir.is_dir():
        return
    links = [profile_dir / name for name in CHROME_SINGLETON_NAMES]
    if not any(link.is_symlink() for link in links):
        return
    lease = _acquire_profile_lease(profile_dir)
    if lease is None:
        return
    try:
        if _chrome_uses_profile(profile_dir):
            return
        for link in links:
            if link.is_symlink():
                try:
                    link.unlink()
                except OSError:
                    pass
        _event("flow_try_on.stale_profile_locks_removed")
    finally:
        lease.release()


def _run_gflow(args: list[str], timeout_seconds: float, db_path: Path) -> tuple[int, str]:
    """Run one gflow command; ``(exit code, stdout)``. Timeouts kill the whole process group."""
    if timeout_seconds <= 0:
        return WORKER_TIMEOUT_EXIT_CODE, ""
    if _warm_runner is not None:
        # The warm browser holds gflow's profile lease; a second gflow could not start beside it.
        _warm_runner.stop("subprocess")
    _clean_stale_profile_locks()
    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            env=_gflow_env(db_path),
        )
    except OSError:
        return 1, ""

    try:
        stdout, _stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        _terminate_process_group(process)
        return WORKER_TIMEOUT_EXIT_CODE, ""
    return process.returncode, stdout or ""


def _wire_diagnostics(detail: str) -> dict[str, str]:
    """Enum-only facts from the try-on guard's error detail, safe to log.

    Only SCREAMING_SNAKE tokens pass the patterns below, never provider text or shopper data.
    They are what an operator needs to set the fallback up from one live run: the RESOURCE_EXHAUSTED
    refusal reasons, and the enum tokens of an aborted Nano Banana 2.1 submit (its model key).
    """
    fields: dict[str, str] = {}
    quota = re.search(re.escape(QUOTA_EXHAUSTED_MARKER) + r"[^(]*\(([A-Z0-9_, ]{0,400})\)", detail)
    if quota:
        fields["quota_reasons"] = quota.group(1)
    candidates = re.search(r"WIRE_MODEL_CANDIDATES=([A-Z0-9_,]{0,1600})", detail)
    if candidates:
        fields["wire_model_candidates"] = candidates.group(1)
    return fields


def _run_model_warm(
    model: str,
    person: Path,
    product: Path,
    output: Path,
    timeout_seconds: float,
) -> tuple[int, GflowMachineError] | None:
    """Run on the warm browser: ``(exit code, error)``, or ``None`` to run it the old way.

    ``None`` only when the browser could not be started or died before the image submit, so nothing
    has been spent and the request can still be served by its own gflow process.
    """
    if _warm_runner is None or _project_id is None or timeout_seconds <= 0:
        return None
    outcome = _warm_runner.run(
        {
            "model": model,
            "prompt": TRY_ON_PROMPT,
            "person": str(person),
            "product": str(product),
            "output": str(output),
            "project": _project_id,
        },
        timeout_seconds,
    )
    if outcome.kind == "unavailable":
        _event("flow_try_on.warm_unavailable", model=model)
        return None
    if outcome.kind == "timeout":
        return WORKER_TIMEOUT_EXIT_CODE, GflowMachineError()
    return outcome.exit_code, _machine_error(outcome.stdout)


def _run_model(
    model: str,
    person: Path,
    product: Path,
    output: Path,
    timeout_seconds: float,
    db_path: Path,
) -> tuple[int, GflowMachineError]:
    if _project_id is None:
        return 1, GflowMachineError()
    deadline = _monotonic() + timeout_seconds
    warm = _run_model_warm(model, person, product, output, timeout_seconds)
    if warm is not None:
        returncode, error = warm
        if returncode == WORKER_TIMEOUT_EXIT_CODE:
            return returncode, GflowMachineError()
    else:
        # A warm browser that failed to start may have used much of the budget. The request has one
        # deadline, so the per-request gflow gets only what is left of it, and nothing when it is gone.
        remaining = deadline - _monotonic()
        if remaining <= 0:
            return WORKER_TIMEOUT_EXIT_CODE, GflowMachineError()
        returncode, stdout = _run_gflow(_command(model, person, product, output), remaining, db_path)
        if returncode == WORKER_TIMEOUT_EXIT_CODE:
            return returncode, GflowMachineError()
        error = _machine_error(stdout)
    if returncode != 0:
        fields = {
            "model": model,
            "exit_code": str(returncode),
            "error_class": error.error_class or "unknown",
            **_wire_diagnostics(error.detail),
        }
        _event("flow_try_on.process_error", **fields)

    return returncode, error


def _project_state_path() -> Path:
    return GFLOW_HOME / PROJECT_STATE_FILE


class ProjectStateError(RuntimeError):
    pass


def _stored_project_id() -> str | None:
    """The recorded try-on project id, or ``None`` only when no record exists.

    A record that exists but cannot be read, does not hold a valid id, or is still the pending
    marker of an earlier create raises instead: treating it as missing would create a second
    project and break the one-project guarantee.
    """
    try:
        raw = _project_state_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ProjectStateError("unreadable") from exc
    try:
        state = json.loads(raw)
    except ValueError as exc:
        raise ProjectStateError("corrupt") from exc
    project_id = state.get("projectId") if isinstance(state, dict) else None
    if isinstance(project_id, str) and PROJECT_ID_PATTERN.fullmatch(project_id):
        return project_id
    if isinstance(state, dict) and state.get("pending") is True and project_id is None:
        raise ProjectStateError("pending")
    raise ProjectStateError("invalid")


def _write_project_state(state: dict[str, Any]) -> None:
    path = _project_state_path()
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(state), encoding="utf-8")
    os.replace(temporary, path)


def _store_project_id(project_id: str) -> None:
    _write_project_state({"projectId": project_id, "title": PROJECT_TITLE})


# gflow exits that end before Flow is asked to create anything: no session (3, 8) or the profile
# lease held by another run. Only after these may the pending marker be withdrawn.
_PRE_FLOW_EXIT_CODES = (3, 8)


def _failed_before_flow(returncode: int, error: GflowMachineError) -> bool:
    return returncode in _PRE_FLOW_EXIT_CODES or (
        returncode == 11 and error.error_class == "ProfileLockedError"
    )


def _ensure_project(timeout_seconds: float, db_path: Path) -> tuple[int, GflowMachineError]:
    """Resolve the one try-on project; create it at most once per gflow volume.

    Before ``gflow project create`` runs, a pending marker is written to the state file. If the
    worker dies or loses the reply after Flow created the project, or cannot record the id, the
    marker (or the id) stays in the volume, so no later request or restarted worker creates a
    second project: they refuse generation until an operator records the id or sets
    LA_TRY_ON_FLOW_PROJECT_ID. A created but unrecorded id is also kept in memory, so this
    process retries the write rather than the create.
    """
    global _project_id, _unrecorded_project_id
    if _project_id is not None:
        return 0, GflowMachineError()
    if _unrecorded_project_id is None:
        try:
            stored = _stored_project_id()
        except ProjectStateError as exc:
            _event("flow_try_on.project_state_invalid", problem=str(exc), path=str(_project_state_path()))
            return 1, GflowMachineError()
        if stored is not None:
            _project_id = stored
            return 0, GflowMachineError()

    created = _unrecorded_project_id
    if created is None:
        try:
            _write_project_state({"pending": True, "title": PROJECT_TITLE, "since": int(time.time())})
        except OSError:
            _event("flow_try_on.project_record_failed", path=str(_project_state_path()))
            return 1, GflowMachineError()
        returncode, stdout = _run_gflow(
            _gflow("project", "create", "--title", PROJECT_TITLE, "--profile", PROFILE, "--json"),
            timeout_seconds,
            db_path,
        )
        try:
            reply = json.loads(stdout)
        except ValueError:
            reply = None
        created = reply.get("project_id") if isinstance(reply, dict) and reply.get("status") == "ok" else None
        if returncode != 0 or not isinstance(created, str) or not PROJECT_ID_PATTERN.fullmatch(created):
            error = _machine_error(stdout)
            if _failed_before_flow(returncode, error):
                # Nothing reached Flow, so no project can exist: the next request may create.
                # If the marker cannot be removed it keeps blocking, which is the safe side.
                try:
                    _project_state_path().unlink(missing_ok=True)
                except OSError:
                    pass
            # Otherwise (timeout, unreadable reply, any other failure) Flow may have created it:
            # the pending marker stays and blocks a second create.
            _event("flow_try_on.project_create_failed", exit_code=str(returncode))
            return returncode or 1, error
        _unrecorded_project_id = created
        _event("flow_try_on.project_created", project_id=created)
    try:
        _store_project_id(created)
    except OSError:
        # The id is the operator's evidence: record it by hand or set LA_TRY_ON_FLOW_PROJECT_ID.
        _event("flow_try_on.project_record_failed", project_id=created, path=str(_project_state_path()))
        return 1, GflowMachineError()
    _unrecorded_project_id = None
    _project_id = created
    _event("flow_try_on.project_recorded", project_id=created)
    return 0, GflowMachineError()


def _failure_reason(
    exit_code: int,
    error: GflowMachineError | None = None,
) -> tuple[int, str]:
    # gflow-cli 0.82.1 EXIT_CODE_MAP. Keep failure mapping structural; never infer safety/auth from
    # arbitrary provider text. The only text-sensitive branch is the narrowly tested Pro daily quota.
    if exit_code in (3, 8):
        return 401, "AUTH_FAILED"
    if (
        exit_code == 11
        and error is not None
        and error.error_class == "ProfileLockedError"
        and error.problem_type == "https://gflow-cli.dev/errors/profile-locked"
    ):
        return 409, "BUSY"
    if exit_code == 4:
        return 429, "BUSY"
    # flow.google.com quota refusals arrive as exit 7 (WireFormatError); only the verified quota
    # signals are BUSY, every other wire error stays GENERATION_FAILED.
    if error is not None and is_flow_quota_refusal(exit_code, error.detail):
        return 429, "BUSY"
    if exit_code == 5:
        return 422, "SAFETY_BLOCKED"
    if exit_code in (9, WORKER_TIMEOUT_EXIT_CODE):
        return 504, "TIMEOUT"
    return 502, "GENERATION_FAILED"


def _generate(person: bytes, person_mime: str, product: bytes, product_mime: str) -> tuple[str, bytes, str]:
    suffix = {"image/jpeg": ".jpg", "image/png": ".png"}
    deadline = time.monotonic() + GENERATION_BUDGET_SECONDS

    def remaining_budget() -> float:
        return max(0.0, deadline - time.monotonic())

    with tempfile.TemporaryDirectory(prefix="flow-try-on-") as temp:
        root = Path(temp)
        # gflow appends a unique 8-char hex suffix to uploaded asset names inside Flow
        # (_unique_display_name). Using short basenames avoids exceeding the Flow mention picker
        # search query length, which causes mention matching failures and ReferenceNotFoundError.
        person_path = root / f"person{suffix[person_mime]}"
        product_path = root / f"garment{suffix[product_mime]}"
        output_path = root / "result.png"
        db_path = root / "gflow.db"
        person_path.write_bytes(person)
        product_path.write_bytes(product)

        exit_code, error = _ensure_project(remaining_budget(), db_path)
        if exit_code != 0:
            status, reason = _failure_reason(exit_code, error)
            _event("flow_try_on.generation_failed", model="none", reason=reason)
            raise WorkerGenerationError(status, reason)

        _event("flow_try_on.model_attempt", model="nano-banana-pro")
        exit_code, error = _run_model(
            "nano-pro",
            person_path,
            product_path,
            output_path,
            remaining_budget(),
            db_path,
        )
        model = "nano-banana-pro"
        if exit_code != 0 and should_fallback_from_pro(exit_code, error.detail):
            _event("flow_try_on.model_fallback", source="nano-banana-pro", target="nano-banana-2.1")
            output_path.unlink(missing_ok=True)
            # In the gflow launcher, nano2 selects exactly "Nano Banana 2.1" (see gflow_models).
            exit_code, error = _run_model(
                "nano2",
                person_path,
                product_path,
                output_path,
                remaining_budget(),
                db_path,
            )
            model = "nano-banana-2.1"

        if exit_code != 0:
            status, reason = _failure_reason(exit_code, error)
            _event("flow_try_on.generation_failed", model=model, reason=reason)
            raise WorkerGenerationError(status, reason)

        output_candidates = (
            output_path,
            root / f"{output_path.stem}.jpg",
            root / f"{output_path.stem}.jpeg",
            root / f"{output_path.stem}.png",
        )
        output_file = next((p for p in output_candidates if p.is_file()), None)
        if output_file is None:
            raise WorkerGenerationError(502, "GENERATION_FAILED")
        data = output_file.read_bytes()
        mime = _sniff_mime(data)
        if mime is None or not data or len(data) > MAX_OUTPUT_BYTES:
            _event("flow_try_on.generation_failed", model=model, reason="GENERATION_FAILED")
            raise WorkerGenerationError(502, "GENERATION_FAILED")
        _event("flow_try_on.generation_succeeded", model=model)
        return model, data, mime


class WorkerGenerationError(RuntimeError):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


class Handler(BaseHTTPRequestHandler):
    server_version = "flow-try-on-worker"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request metadata can include sensitive operational detail. The storefront owns telemetry.
        return

    def _json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._json(404, {"ok": False})
            return
        if not _profile_present():
            self._json(503, {"ok": False, "reason": "AUTH_FAILED"})
            return
        body: dict[str, Any] = {"ok": True}
        if _warm_runner is not None:
            body["warm"] = _warm_runner.status()
        self._json(200, body)

    def _authorized(self) -> bool:
        """The bearer token and the signed-in profile; answers 401 itself when either is missing."""
        expected = f"Bearer {TOKEN}"
        supplied = self.headers.get("authorization", "")
        if not TOKEN or len(TOKEN) < 32 or not hmac.compare_digest(supplied, expected):
            self._json(401, {"ok": False, "reason": "AUTH_FAILED"})
            return False
        if not _profile_present():
            self._json(401, {"ok": False, "reason": "AUTH_FAILED"})
            return False
        return True

    def _warm(self) -> None:
        """Start the browser in the background; answers at once with the state it is in."""
        if not self._authorized():
            return
        if _warm_runner is None:
            self._json(200, {"ok": True, "state": "disabled"})
        elif _project_id is None:
            # The first request creates the project with its own gflow; a browser started now would
            # hold the profile lease against it.
            self._json(200, {"ok": True, "state": "cold"})
        else:
            self._json(200, {"ok": True, "state": _warm_runner.warm()})

    def _cool(self) -> None:
        """Release the browser and its profile lease, for `gflow auth login` and other operator work."""
        if not self._authorized():
            return
        if _warm_runner is None:
            self._json(200, {"ok": True, "state": "disabled"})
            return
        if not _generation_lock.acquire(blocking=False):
            self._json(409, {"ok": False, "reason": "BUSY"})
            return
        try:
            _warm_runner.stop("cool")
        finally:
            _generation_lock.release()
        self._json(200, {"ok": True, "state": "cold"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/v1/warm":
            self._warm()
            return
        if self.path == "/v1/cool":
            self._cool()
            return
        if self.path != "/v1/try-on":
            self._json(404, {"ok": False})
            return

        expected = f"Bearer {TOKEN}"
        supplied = self.headers.get("authorization", "")
        if not TOKEN or len(TOKEN) < 32 or not hmac.compare_digest(supplied, expected):
            self._json(401, {"ok": False, "reason": "AUTH_FAILED"})
            return
        if not _profile_present():
            self._json(401, {"ok": False, "reason": "AUTH_FAILED"})
            return

        content_type = self.headers.get("content-type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            self._json(400, {"ok": False, "reason": "GENERATION_FAILED"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self._json(413, {"ok": False, "reason": "GENERATION_FAILED"})
            return

        if not _generation_lock.acquire(blocking=False):
            self._json(409, {"ok": False, "reason": "BUSY"})
            return

        try:
            try:
                self.connection.settimeout(REQUEST_READ_TIMEOUT_SECONDS)
                raw_body = self.rfile.read(length)
                self.connection.settimeout(None)
                if len(raw_body) != length:
                    raise RequestError("incomplete request")
                body = json.loads(raw_body)
                if not isinstance(body, dict) or set(body) != {"person", "product"}:
                    raise RequestError("invalid request")
                person, person_mime = _decode_image(body["person"])
                product, product_mime = _decode_image(body["product"])
            except (json.JSONDecodeError, UnicodeDecodeError, RequestError, TimeoutError, OSError):
                self._json(400, {"ok": False, "reason": "GENERATION_FAILED"})
                return
            finally:
                try:
                    self.connection.settimeout(None)
                except OSError:
                    pass

            try:
                model, image, mime = _generate(person, person_mime, product, product_mime)
            except WorkerGenerationError as error:
                self._json(error.status, {"ok": False, "reason": error.reason})
                return
            except Exception:
                self._json(502, {"ok": False, "reason": "GENERATION_FAILED"})
                return

            self._json(
                200,
                {
                    "ok": True,
                    "model": model,
                    "mimeType": mime,
                    "imageBase64": base64.b64encode(image).decode("ascii"),
                },
            )
        finally:
            _generation_lock.release()


def _start_warm_browser() -> None:
    """Turn on the warm browser: its runner, the thread that releases it when idle, and its shutdown."""
    global _warm_runner
    _warm_runner = WarmRunner(
        config=WARM_CONFIG,
        spawn=spawn_child(lambda scratch: _gflow_env(Path(scratch) / "gflow.db")),
        event=_event,
    )

    def maintain() -> None:
        while True:
            time.sleep(WARM_MAINTENANCE_SECONDS)
            try:
                assert _warm_runner is not None
                _warm_runner.maintain()
            except Exception:
                _event("flow_warm.maintain_failed")

    threading.Thread(target=maintain, daemon=True).start()

    def terminate(_signum: int, _frame: Any) -> None:
        if _warm_runner is not None:
            _warm_runner.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    _event("flow_warm.enabled")


def main() -> None:
    if len(TOKEN) < 32:
        raise SystemExit("FLOW_WORKER_TOKEN must contain at least 32 characters")
    if PROFILE_PATTERN.fullmatch(PROFILE) is None:
        raise SystemExit("GFLOW_CLI_PROFILE contains unsupported characters")
    if PROJECT_ID and PROJECT_ID_PATTERN.fullmatch(PROJECT_ID) is None:
        raise SystemExit("FLOW_PROJECT_ID must be 1-128 letters, digits or hyphens")
    _clean_stale_profile_locks()
    if WARM_BROWSER:
        _start_warm_browser()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
