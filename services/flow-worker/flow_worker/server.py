from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .policy import should_fallback_to_nano2

HOST = os.environ.get("FLOW_WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLOW_WORKER_PORT", "8787"))
TOKEN = os.environ.get("FLOW_WORKER_TOKEN", "")
PROFILE = os.environ.get("GFLOW_CLI_PROFILE", "default")
GFLOW_HOME = Path(os.environ.get("GFLOW_CLI_HOME", "/data/gflow"))
PROJECT_ID = os.environ.get("FLOW_PROJECT_ID", "").strip()
GENERATION_BUDGET_SECONDS = int(os.environ.get("FLOW_COMMAND_TIMEOUT_SECONDS", "50"))
REQUEST_READ_TIMEOUT_SECONDS = int(os.environ.get("FLOW_REQUEST_READ_TIMEOUT_SECONDS", "15"))
MAX_IMAGE_BYTES = 7 * 1024 * 1024
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_ERROR_DETAIL_CHARS = 4 * 1024
WORKER_TIMEOUT_EXIT_CODE = 124
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

TRY_ON_PROMPT = """Use the first reference image as the person and the second reference image as the garment.
Dress the person naturally in the exact referenced garment.
Preserve the person's face, identity, apparent age, pose, body proportions, skin tone, hair and framing.
Preserve the garment's silhouette, color, pattern, fabric appearance, embroidery and visible design details.
Do not add unrelated clothing or accessories. Do not alter body shape. Do not sexualize the subject.
Produce one realistic, age-appropriate fashion try-on image."""

_generation_lock = threading.Lock()


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


def _profile_present() -> bool:
    return PROFILE_PATTERN.fullmatch(PROFILE) is not None and (GFLOW_HOME / f"profile_{PROFILE}").is_dir()


def _command(model: str, person: Path, product: Path, output: Path) -> list[str]:
    args = [
        "gflow",
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
        "--json",
    ]
    if PROJECT_ID:
        args.extend(["--project", PROJECT_ID])
    return args


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
    env["GFLOW_CLI_HEADLESS"] = "false"
    env["GFLOW_CLI_HISTORY_PROMPTS"] = "redacted"
    env["GFLOW_CLI_UPDATE_CHECK"] = "false"
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


def _run_model(
    model: str,
    person: Path,
    product: Path,
    output: Path,
    timeout_seconds: float,
    db_path: Path,
) -> tuple[int, GflowMachineError]:
    if timeout_seconds <= 0:
        return WORKER_TIMEOUT_EXIT_CODE, GflowMachineError()
    try:
        process = subprocess.Popen(
            _command(model, person, product, output),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env=_gflow_env(db_path),
        )
    except OSError:
        return 1, GflowMachineError()

    try:
        stdout, _ = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        _terminate_process_group(process)
        return WORKER_TIMEOUT_EXIT_CODE, GflowMachineError()

    return process.returncode, _machine_error(stdout or "")


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
        person_path = root / f"person{suffix[person_mime]}"
        product_path = root / f"garment{suffix[product_mime]}"
        output_path = root / "result.png"
        db_path = root / "gflow.db"
        person_path.write_bytes(person)
        product_path.write_bytes(product)

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
        if exit_code != 0 and should_fallback_to_nano2(exit_code, error.detail):
            _event("flow_try_on.model_fallback", source="nano-banana-pro", target="nano-banana-2")
            output_path.unlink(missing_ok=True)
            exit_code, error = _run_model(
                "nano2",
                person_path,
                product_path,
                output_path,
                remaining_budget(),
                db_path,
            )
            model = "nano-banana-2"

        if exit_code != 0:
            status, reason = _failure_reason(exit_code, error)
            _event("flow_try_on.generation_failed", model=model, reason=reason)
            raise WorkerGenerationError(status, reason)

        if not output_path.is_file():
            raise WorkerGenerationError(502, "GENERATION_FAILED")
        data = output_path.read_bytes()
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
        self._json(200, {"ok": True})

    def do_POST(self) -> None:  # noqa: N802
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


def main() -> None:
    if len(TOKEN) < 32:
        raise SystemExit("FLOW_WORKER_TOKEN must contain at least 32 characters")
    if PROFILE_PATTERN.fullmatch(PROFILE) is None:
        raise SystemExit("GFLOW_CLI_PROFILE contains unsupported characters")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
