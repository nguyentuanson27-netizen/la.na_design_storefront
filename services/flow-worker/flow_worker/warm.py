"""Keeps one signed-in Flow browser warm between try-on requests.

Starting gflow for every request costs a Python start, a Chrome launch and Flow's bootstrap before
any work begins. ``WarmRunner`` instead owns one child process (``flow_worker.warm_child``) that holds
the browser open and serves jobs, and decides when that browser should exist at all:

* ``COLD``  no child. The next request, or ``POST /v1/warm``, starts one.
* ``WARM``  the child is up and idle between requests.

A warm browser is not free (it holds Chrome's memory and gflow's profile lease), so it is released
when it has been idle for ``idle_seconds``, and recycled, between requests, when it has served
``max_jobs``, lived ``max_age_seconds``, or its process tree holds more than ``max_rss_mb`` (long-lived
tabs leak). A job that failed also recycles it: the next request starts from a clean browser.

The caller serialises jobs (``server._generation_lock``). This class only has to keep its own state
safe from the maintenance thread, ``/v1/warm`` and ``/v1/cool``, which it does with one lock that is
held while a job runs. It never logs prompts, paths or provider text, only counters and enums.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

COLD = "cold"
WARM = "warm"

TIMEOUT_EXIT_CODE = 124
_GRACEFUL_STOP_SECONDS = 10.0


@dataclass(frozen=True, slots=True)
class WarmConfig:
    idle_seconds: float = 1800.0
    max_jobs: int = 50
    max_age_seconds: float = 3600.0
    max_rss_mb: int = 1200
    start_timeout_seconds: float = 90.0
    min_restart_seconds: float = 60.0


@dataclass(frozen=True, slots=True)
class WarmOutcome:
    """What one job came to. ``kind`` is ``done``, ``unavailable`` or ``timeout``.

    ``unavailable`` means the browser could not be started, or died before the image submit went out:
    nothing was spent, so the caller may run the request the old way. ``done`` carries gflow's exit
    code and ``--json`` stdout. ``timeout`` is the request budget running out, and ``submitted`` tells
    the caller whether the submit had already gone out when the browser died or timed out.
    """

    kind: str
    exit_code: int = 0
    stdout: str = ""
    submitted: bool = False


def _statm_rss_mb(pid: int, page_size: int) -> float:
    try:
        with open(f"/proc/{pid}/statm", encoding="ascii") as handle:
            return int(handle.read().split()[1]) * page_size / (1024 * 1024)
    except (OSError, ValueError, IndexError):
        return 0.0


def process_tree_rss_mb(root_pid: int) -> float:
    """Resident memory of *root_pid* and everything under it, from /proc. 0.0 where there is no /proc."""
    proc = "/proc"
    if not os.path.isdir(proc):
        return 0.0
    page_size = os.sysconf("SC_PAGE_SIZE")
    parents: dict[int, int] = {}
    groups: dict[int, int] = {}
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        try:
            with open(f"{proc}/{name}/stat", encoding="ascii", errors="replace") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        # After the command name: state, ppid, pgrp, ...
        parents[int(name)] = int(fields[1])
        groups[int(name)] = int(fields[2])
    members = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if pid not in members and (parent in members or groups.get(pid) == root_pid):
                members.add(pid)
                changed = True
    return sum(_statm_rss_mb(pid, page_size) for pid in members)


class _Child:
    """One running warm_child process, its reply reader and its scratch directory."""

    def __init__(self, process: subprocess.Popen[str], scratch: str) -> None:
        self.process = process
        self.scratch = scratch
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.started_at = time.monotonic()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        stream = self.process.stdout
        try:
            while stream is not None:
                line = stream.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    self.messages.put(message)
        except (OSError, ValueError):
            pass
        finally:
            self.messages.put({"event": "eof"})

    def alive(self) -> bool:
        return self.process.poll() is None

    def send(self, message: dict[str, Any]) -> bool:
        stream = self.process.stdin
        if stream is None:
            return False
        try:
            stream.write(json.dumps(message, separators=(",", ":")) + "\n")
            stream.flush()
            return True
        except (OSError, ValueError):
            return False


class WarmRunner:
    def __init__(
        self,
        *,
        config: WarmConfig,
        spawn: Callable[[str], subprocess.Popen[str]],
        event: Callable[..., None],
        clock: Callable[[], float] = time.monotonic,
        rss_mb: Callable[[int], float] = process_tree_rss_mb,
    ) -> None:
        self._config = config
        self._spawn = spawn
        self._event = event
        self._clock = clock
        self._rss_mb = rss_mb
        self._lock = threading.RLock()  # held while a job runs, starts or stops the child
        self._child: _Child | None = None
        self._jobs = 0
        self._next_id = 0
        self._last_activity = clock()
        self._last_start_attempt: float | None = None
        self._recycle_reason: str | None = None
        self._warming = False
        self._guard = threading.Lock()  # only the warming flag

    # -- state ---------------------------------------------------------------------------------

    @property
    def state(self) -> str:
        child = self._child
        return WARM if child is not None and child.alive() else COLD

    def status(self) -> dict[str, Any]:
        child = self._child
        if child is None or not child.alive():
            return {"state": COLD}
        now = self._clock()
        return {
            "state": WARM,
            "jobs": self._jobs,
            "ageSeconds": int(now - child.started_at),
            "idleSeconds": int(now - self._last_activity),
            "rssMb": int(self._rss_mb(child.process.pid)),
        }

    # -- starting and stopping (the caller holds the lock) -------------------------------------

    def _start_locked(self, deadline: float) -> bool:
        self._last_start_attempt = self._clock()
        scratch = tempfile.mkdtemp(prefix="flow-warm-")
        try:
            process = self._spawn(scratch)
        except OSError:
            shutil.rmtree(scratch, ignore_errors=True)
            self._event("flow_warm.start_failed", reason="spawn")
            return False
        child = _Child(process, scratch)
        limit = min(deadline, self._clock() + self._config.start_timeout_seconds)
        while True:
            try:
                message = child.messages.get(timeout=max(0.0, limit - self._clock()))
            except queue.Empty:
                self._kill(child)
                self._event("flow_warm.start_failed", reason="timeout")
                return False
            if message.get("event") == "ready":
                break
            if message.get("event") == "eof":
                self._kill(child)
                self._event("flow_warm.start_failed", reason="exited")
                return False
        self._child = child
        self._jobs = 0
        self._last_activity = self._clock()
        self._recycle_reason = None
        self._event("flow_warm.started", startup_ms=str(int((self._clock() - child.started_at) * 1000)))
        return True

    def _kill(self, child: _Child) -> None:
        process = child.process
        if process.poll() is None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)
                except OSError:
                    break
                try:
                    process.wait(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    continue
        for stream in (process.stdin, process.stdout):
            try:
                if stream is not None:
                    stream.close()
            except (OSError, ValueError):
                pass
        shutil.rmtree(child.scratch, ignore_errors=True)

    def _stop_locked(self, reason: str) -> None:
        child = self._child
        self._child = None
        self._recycle_reason = None
        if child is None:
            return
        if child.alive() and child.send({"op": "stop"}):
            try:
                child.process.wait(timeout=_GRACEFUL_STOP_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        self._kill(child)
        self._event("flow_warm.stopped", reason=reason, jobs=str(self._jobs))

    def shutdown(self) -> None:
        """Kill the browser at once, without waiting for a running job. For process exit."""
        child = self._child
        self._child = None
        if child is not None:
            self._kill(child)

    def stop(self, reason: str = "requested") -> None:
        """Release the browser and its profile lease. Waits for a running job to finish first."""
        with self._lock:
            self._stop_locked(reason)

    # -- jobs ----------------------------------------------------------------------------------

    def run(self, job: dict[str, Any], budget_seconds: float) -> WarmOutcome:
        """Run one generation on the warm browser, starting it first if it is cold."""
        deadline = self._clock() + budget_seconds
        if not self._lock.acquire(timeout=max(0.0, budget_seconds)):
            return WarmOutcome("timeout")
        try:
            return self._run_locked(job, deadline)
        finally:
            self._lock.release()

    def _run_locked(self, job: dict[str, Any], deadline: float) -> WarmOutcome:
        if self._recycle_reason is not None:
            self._stop_locked(self._recycle_reason)
        child = self._child
        if child is not None and not child.alive():
            self._stop_locked("died")
            child = None
        if child is None:
            if not self._start_locked(deadline):
                return WarmOutcome("unavailable")
            child = self._child
        assert child is not None

        self._next_id += 1
        job_id = self._next_id
        if not child.send({**job, "id": job_id, "op": "generate"}):
            self._stop_locked("send_failed")
            return WarmOutcome("unavailable")

        submitted = False
        while True:
            remaining = deadline - self._clock()
            try:
                message = child.messages.get(timeout=max(0.0, remaining))
            except queue.Empty:
                self._stop_locked("job_timeout")
                return WarmOutcome("timeout", TIMEOUT_EXIT_CODE, submitted=submitted)
            if message.get("event") == "submitted" and message.get("id") == job_id:
                submitted = True
            elif message.get("event") == "eof":
                self._stop_locked("died")
                if submitted:
                    return WarmOutcome("done", 1, submitted=True)
                return WarmOutcome("unavailable")
            elif message.get("id") == job_id:
                break

        self._jobs += 1
        self._last_activity = self._clock()
        exit_code = message.get("exitCode")
        exit_code = exit_code if isinstance(exit_code, int) else 1
        stdout = message.get("stdout")
        stdout = stdout if isinstance(stdout, str) else ""
        if exit_code != 0:
            self._recycle_reason = "job_failed"
        else:
            self._recycle_reason = self._recycle_due(child)
        return WarmOutcome("done", exit_code, stdout, submitted=submitted)

    # -- lifecycle policy ----------------------------------------------------------------------

    def _recycle_due(self, child: _Child) -> str | None:
        now = self._clock()
        if self._jobs >= self._config.max_jobs:
            return "max_jobs"
        if now - child.started_at >= self._config.max_age_seconds:
            return "max_age"
        if self._rss_mb(child.process.pid) >= self._config.max_rss_mb:
            return "max_rss"
        return None

    def maintain(self) -> None:
        """Idle release and recycling. Called periodically; does nothing while a job holds the lock."""
        if not self._lock.acquire(blocking=False):
            return
        try:
            child = self._child
            if child is None:
                return
            if not child.alive():
                self._stop_locked("died")
                return
            if self._recycle_reason is not None:
                self._stop_locked(self._recycle_reason)
                return
            if self._clock() - self._last_activity >= self._config.idle_seconds:
                self._stop_locked("idle")
                return
            reason = self._recycle_due(child)
            if reason is not None:
                self._stop_locked(reason)
        finally:
            self._lock.release()

    def warm(self) -> str:
        """Start the browser in the background if it is cold. Returns the state to report now."""
        child = self._child
        if child is not None and child.alive():
            return WARM
        with self._guard:
            if self._warming:
                return "starting"
            last = self._last_start_attempt
            if last is not None and self._clock() - last < self._config.min_restart_seconds:
                return COLD
            self._warming = True
        threading.Thread(target=self._warm_in_background, daemon=True).start()
        return "starting"

    def _warm_in_background(self) -> None:
        try:
            with self._lock:
                if self._child is None or not self._child.alive():
                    self._start_locked(self._clock() + self._config.start_timeout_seconds)
        finally:
            with self._guard:
                self._warming = False


def spawn_child(env_for: Callable[[str], dict[str, str]]) -> Callable[[str], subprocess.Popen[str]]:
    """A ``spawn`` for :class:`WarmRunner` that starts ``flow_worker.warm_child`` in its own session.

    ``env_for(scratch)`` builds the child's environment from the child's scratch directory.
    """

    def spawn(scratch: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [sys.executable, "-m", "flow_worker.warm_child"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env=env_for(scratch),
        )

    return spawn
