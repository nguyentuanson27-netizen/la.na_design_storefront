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
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator

COLD = "cold"
WARM = "warm"

TIMEOUT_EXIT_CODE = 124
_GRACEFUL_STOP_SECONDS = 10.0
# How long each signal (SIGTERM, then SIGKILL) is given to take the whole process group down.
_KILL_WAIT_SECONDS = 3.0


@dataclass(frozen=True, slots=True)
class WarmConfig:
    idle_seconds: float = 1800.0
    max_jobs: int = 50
    max_age_seconds: float = 3600.0
    max_rss_mb: int = 1200
    start_timeout_seconds: float = 90.0
    min_restart_seconds: float = 60.0
    # How long a cool request keeps the browser from being started again (see WarmRunner.cool).
    cool_pause_seconds: float = 900.0


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


def _group_members(pgid: int) -> list[int]:
    """Live (not zombie) processes in process group *pgid*, whether or not its leader is still there.

    A process group outlives its leader: when the warm child crashes, the gflow/Playwright/Chrome
    processes it started stay in the group and can keep holding the Chrome profile. Without /proc the
    group's existence is the best answer there is.
    """
    proc = "/proc"
    if not os.path.isdir(proc):
        try:
            os.killpg(pgid, 0)
        except OSError:
            return []
        return [pgid]
    members: list[int] = []
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        try:
            with open(f"{proc}/{name}/stat", encoding="ascii", errors="replace") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        # After the command name: state, ppid, pgrp, ...
        if len(fields) > 2 and fields[2] == str(pgid) and fields[0] != "Z":
            members.append(int(name))
    return members


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
        self._guard = threading.Lock()  # the warming flag, the epoch, the pause and the exclusive count
        # Bumped by every cool and by every exclusive section. A start that began under an earlier
        # epoch is stale: it gives up, and a scheduled start that wakes under a later one never starts.
        self._epoch = 0
        self._paused_until = 0.0
        self._exclusive = 0
        # Process groups whose kill did not finish: Chrome may still hold the profile in them.
        self._leaked: list[int] = []

    # -- state ---------------------------------------------------------------------------------

    @property
    def state(self) -> str:
        child = self._child
        return WARM if child is not None and child.alive() else COLD

    def status(self) -> dict[str, Any]:
        child = self._child
        if child is None or not child.alive():
            return {"state": COLD, "paused": self._exclusive > 0 or self._clock() < self._paused_until}
        now = self._clock()
        return {
            "state": WARM,
            "jobs": self._jobs,
            "ageSeconds": int(now - child.started_at),
            "idleSeconds": int(now - self._last_activity),
            "rssMb": int(self._rss_mb(child.process.pid)),
        }

    # -- starting and stopping (the caller holds the lock) -------------------------------------

    def _leaked_alive(self) -> bool:
        """Whether a process group that a kill failed to clear still has live members."""
        self._leaked = [pgid for pgid in self._leaked if _group_members(pgid)]
        return bool(self._leaked)

    def _blocked(self, epoch: int) -> bool:
        """Whether a start under *epoch* must not begin or go on: cooled, paused or exclusive since."""
        with self._guard:
            return self._epoch != epoch or self._exclusive > 0 or self._clock() < self._paused_until

    def _start_locked(self, deadline: float, epoch: int) -> bool:
        if self._blocked(epoch):
            return False
        if self._leaked_alive():
            # An earlier browser's processes are still running and may hold the profile.
            self._event("flow_warm.start_failed", reason="profile_held")
            return False
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
                # Short waits, so a cool or an exclusive section ends a start in progress promptly.
                message = child.messages.get(timeout=max(0.0, min(0.2, limit - self._clock())))
            except queue.Empty:
                if self._blocked(epoch):
                    self._kill(child)
                    self._event("flow_warm.start_failed", reason="cancelled")
                    return False
                if self._clock() >= limit:
                    self._kill(child)
                    self._event("flow_warm.start_failed", reason="timeout")
                    return False
                continue
            if message.get("event") == "ready":
                break
            if message.get("event") == "eof":
                self._kill(child)
                self._event("flow_warm.start_failed", reason="exited")
                return False
        if self._blocked(epoch):
            self._kill(child)
            self._event("flow_warm.start_failed", reason="cancelled")
            return False
        self._child = child
        self._jobs = 0
        self._last_activity = self._clock()
        self._recycle_reason = None
        self._event("flow_warm.started", startup_ms=str(int((self._clock() - child.started_at) * 1000)))
        return True

    def _kill(self, child: _Child) -> bool:
        """Take down the child's whole process group; ``True`` once no live process is left in it.

        Independent of whether the group leader is still running: a crashed leader leaves its
        descendants (Chrome) behind in the group, and those hold the profile. SIGTERM first, then
        SIGKILL for whatever is still there, checking the group's membership (not just the leader)
        after each.
        """
        process = child.process
        pgid = process.pid
        for sig in (signal.SIGTERM, signal.SIGKILL):
            process.poll()  # reap the leader if it has exited, so it is not mistaken for a member
            if process.returncode is not None and not _group_members(pgid):
                break
            try:
                os.killpg(pgid, sig)
            except OSError:
                pass  # the group is already gone
            deadline = time.monotonic() + _KILL_WAIT_SECONDS
            while time.monotonic() < deadline:
                process.poll()
                if not _group_members(pgid):
                    break
                time.sleep(0.05)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        released = not _group_members(pgid)
        for stream in (process.stdin, process.stdout):
            try:
                if stream is not None:
                    stream.close()
            except (OSError, ValueError):
                pass
        shutil.rmtree(child.scratch, ignore_errors=True)
        if not released:
            self._leaked.append(pgid)
            self._event("flow_warm.kill_incomplete")
        return released

    def _stop_locked(self, reason: str) -> bool:
        """Release the browser. ``False`` when processes of its group survived (the profile may be held)."""
        child = self._child
        self._child = None
        self._recycle_reason = None
        if child is None:
            return not self._leaked_alive()
        if child.alive() and child.send({"op": "stop"}):
            try:
                child.process.wait(timeout=_GRACEFUL_STOP_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        released = self._kill(child)
        self._event("flow_warm.stopped", reason=reason, jobs=str(self._jobs))
        return released and not self._leaked_alive()

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

    def cool(self, timeout: float = 15.0) -> bool:
        """Release the browser and keep it released for ``cool_pause_seconds``: a barrier for operator work.

        For work that needs the Chrome profile to itself (`gflow auth login`, `gflow auth status`).
        A start that is scheduled or in progress is cancelled, and nothing starts again while the pause
        lasts: not a ``POST /v1/warm`` hint, not a request (it runs on its own gflow process instead).
        Returns ``False`` when the browser could not be released within *timeout* seconds, in which case
        the profile must not be assumed free.
        """
        with self._guard:
            self._epoch += 1
            self._paused_until = self._clock() + self._config.cool_pause_seconds
        if not self._lock.acquire(timeout=timeout):
            return False
        try:
            return self._stop_locked("cool")
        finally:
            self._lock.release()

    def paused(self) -> bool:
        """Whether a cool is in effect: the operator has the Chrome profile, and nothing may use it."""
        with self._guard:
            return self._clock() < self._paused_until

    def resume(self) -> None:
        """End a cool early, once the operator work that needed the profile is done."""
        with self._guard:
            self._paused_until = 0.0

    @contextmanager
    def exclusive(self) -> Iterator[None]:
        """Hold the browser down while something else (a per-request gflow) uses the Chrome profile.

        Releases the browser, cancels any start in progress and refuses new ones until the block ends.
        """
        with self._guard:
            self._epoch += 1
            self._exclusive += 1
        try:
            self.stop("subprocess")
            yield
        finally:
            with self._guard:
                self._exclusive -= 1

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
            with self._guard:
                epoch = self._epoch
            if not self._start_locked(deadline, epoch):
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
            if self._exclusive > 0 or self._clock() < self._paused_until:
                return "paused"
            if self._warming:
                return "starting"
            last = self._last_start_attempt
            if last is not None and self._clock() - last < self._config.min_restart_seconds:
                return COLD
            self._warming = True
            epoch = self._epoch
        threading.Thread(target=self._warm_in_background, args=(epoch,), daemon=True).start()
        return "starting"

    def _warm_in_background(self, epoch: int) -> None:
        try:
            with self._lock:
                if self._child is None or not self._child.alive():
                    self._start_locked(self._clock() + self._config.start_timeout_seconds, epoch)
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
