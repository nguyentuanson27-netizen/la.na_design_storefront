from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import subprocess
import tempfile
import threading
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
COMMAND_TIMEOUT_SECONDS = int(os.environ.get("FLOW_COMMAND_TIMEOUT_SECONDS", "50"))
MAX_IMAGE_BYTES = 7 * 1024 * 1024
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_CLI_CAPTURE_CHARS = 64 * 1024
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


def _run_model(model: str, person: Path, product: Path, output: Path) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            _command(model, person, product, output),
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
            env={
                **os.environ,
                "GFLOW_CLI_HEADLESS": "false",
                "GFLOW_CLI_HISTORY_PROMPTS": "redacted",
                "GFLOW_CLI_UPDATE_CHECK": "false",
            },
        )
    except subprocess.TimeoutExpired:
        return 8, "Transport timeout"
    except OSError:
        return 1, "gflow unavailable"

    combined = (completed.stdout or "") + "\n" + (completed.stderr or "")
    return completed.returncode, combined[-MAX_CLI_CAPTURE_CHARS:]


def _failure_reason(exit_code: int, output: str) -> tuple[int, str]:
    lowered = output.lower()
    if exit_code == 3 or "not_signed_in" in lowered or "auth expired" in lowered:
        return 401, "AUTH_FAILED"
    if exit_code == 5 or "content policy" in lowered or "safety" in lowered:
        return 422, "SAFETY_BLOCKED"
    if exit_code == 4:
        return 429, "BUSY"
    if exit_code == 8 or "timeout" in lowered:
        return 504, "TIMEOUT"
    return 502, "GENERATION_FAILED"


def _generate(person: bytes, person_mime: str, product: bytes, product_mime: str) -> tuple[str, bytes, str]:
    suffix = {"image/jpeg": ".jpg", "image/png": ".png"}
    with tempfile.TemporaryDirectory(prefix="flow-try-on-") as temp:
        root = Path(temp)
        person_path = root / f"person{suffix[person_mime]}"
        product_path = root / f"garment{suffix[product_mime]}"
        output_path = root / "result.png"
        person_path.write_bytes(person)
        product_path.write_bytes(product)

        exit_code, output = _run_model("nano-pro", person_path, product_path, output_path)
        model = "nano-banana-pro"
        if exit_code != 0 and should_fallback_to_nano2(exit_code, output):
            output_path.unlink(missing_ok=True)
            exit_code, output = _run_model("nano2", person_path, product_path, output_path)
            model = "nano-banana-2"

        if exit_code != 0:
            status, reason = _failure_reason(exit_code, output)
            raise WorkerGenerationError(status, reason)

        if not output_path.is_file():
            raise WorkerGenerationError(502, "GENERATION_FAILED")
        data = output_path.read_bytes()
        mime = _sniff_mime(data)
        if mime is None or not data or len(data) > MAX_OUTPUT_BYTES:
            raise WorkerGenerationError(502, "GENERATION_FAILED")
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
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or set(body) != {"person", "product"}:
                    raise RequestError("invalid request")
                person, person_mime = _decode_image(body["person"])
                product, product_mime = _decode_image(body["product"])
            except (json.JSONDecodeError, UnicodeDecodeError, RequestError):
                self._json(400, {"ok": False, "reason": "GENERATION_FAILED"})
                return

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
