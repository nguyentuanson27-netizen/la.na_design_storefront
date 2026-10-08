"""The warm runner: one long-lived process that keeps a signed-in Flow browser open.

The worker (``flow_worker.warm``) starts this as a child process, so Chrome and gflow never share the
worker's address space or environment (the bearer token is not passed on; see ``server._gflow_env``).
It enters one ``FlowApiClient`` (Chrome, profile lease, Flow bootstrap) once and then serves
generation jobs on it, one at a time, until it is told to stop or is killed.

Wire protocol: one JSON object per line. Requests arrive on stdin, replies leave on the original
stdout. Everything else the process prints (gflow's logs, Rich output) is moved to stderr first, so
nothing can corrupt the reply stream.

    <- {"event": "ready"}                                         Chrome is up and signed in
    -> {"id": 1, "op": "generate", "model": "nano-pro", "prompt": "...", "person": "/p.jpg",
        "product": "/g.jpg", "output": "/r.png", "project": "<id>"}
    <- {"event": "submitted", "id": 1}                            the image submit is about to go out
    <- {"id": 1, "exitCode": 0, "stdout": ""}                     the CLI's exit code and --json error
    -> {"op": "stop"}                                             leave the client cleanly and exit

``exitCode`` and ``stdout`` are exactly what ``gflow image i2i --json`` would have produced, so the
worker's failure mapping (``server._failure_reason``) is shared by both paths. gflow is imported
inside functions only, so this module can be loaded (and its protocol tested) without it.

No shopper data is logged, and no operation is recorded: this path never opens gflow's SQLite catalog.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, TextIO

MAX_STDOUT_CHARS = 64 * 1024


def _emit(out: TextIO, message: dict[str, Any]) -> None:
    out.write(json.dumps(message, separators=(",", ":")) + "\n")
    out.flush()


def _failure(exc: BaseException) -> tuple[int, str]:
    """``(exit code, --json stdout)`` for an exception, as gflow's own CLI wrapper reports it."""
    from gflow_cli import json_output
    from gflow_cli._cli_helpers import _exit_code_for
    from gflow_cli.errors import GFlowError

    if isinstance(exc, GFlowError):
        return _exit_code_for(exc), json.dumps(json_output.error_payload(exc))[:MAX_STDOUT_CHARS]
    return 1, ""


async def _generate(client: Any, job: dict[str, Any], on_submit: Any) -> None:
    from gflow_cli.api.image import Aspect, GenerateImageRequest, Model

    request = GenerateImageRequest(
        prompt=job["prompt"],
        aspect=Aspect.from_cli("3:4"),
        model=Model.from_cli(job["model"]),
        ref_paths=(Path(job["person"]), Path(job["product"])),
    )

    def on_checkpoint(checkpoint: Any) -> None:
        if getattr(checkpoint, "phase", "") == "submit_attempted":
            on_submit()

    image = await client.generate_image(
        project_id=job["project"], req=request, on_checkpoint=on_checkpoint
    )
    await client.download_image(image, Path(job["output"]))


async def serve(requests: TextIO, replies: TextIO) -> int:
    """Enter the client, announce readiness and serve jobs. The process exit code."""
    from gflow_cli import auth as auth_mod
    from gflow_cli.api.client import FlowApiClient
    from gflow_cli.config import get_settings

    profile = os.environ.get("GFLOW_CLI_PROFILE", "default")
    settings = get_settings()
    loop = asyncio.get_running_loop()

    async with FlowApiClient(
        profile_dir=auth_mod.profile_dir(profile), headless=settings.headless
    ) as client:
        _emit(replies, {"event": "ready"})
        while True:
            line = await loop.run_in_executor(None, requests.readline)
            if not line:
                return 0  # the worker closed our stdin
            try:
                job = json.loads(line)
            except ValueError:
                continue
            if not isinstance(job, dict) or job.get("op") == "stop":
                return 0
            job_id = job.get("id")
            if job.get("op") != "generate" or not isinstance(job_id, int):
                continue
            try:
                await _generate(
                    client, job, lambda: _emit(replies, {"event": "submitted", "id": job_id})
                )
            except BaseException as exc:  # noqa: BLE001 - every outcome is reported, never raised
                if isinstance(exc, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                    raise
                code, stdout = _failure(exc)
                _emit(replies, {"id": job_id, "exitCode": code, "stdout": stdout})
            else:
                _emit(replies, {"id": job_id, "exitCode": 0, "stdout": ""})


def main() -> None:
    # Keep the reply stream private: dup the real stdout, then point fd 1 at stderr.
    replies = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from . import gflow_models, gflow_prompt_guard

    gflow_prompt_guard.install()
    gflow_models.install()
    raise SystemExit(asyncio.run(serve(sys.stdin, replies)))


if __name__ == "__main__":
    main()
