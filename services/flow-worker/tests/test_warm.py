import http.client
import json
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from flow_worker import server, warm

PROJECT_ID = "66666666-6666-4666-8666-666666666666"

# A stand-in for flow_worker.warm_child that speaks its protocol without gflow or Chrome. Its behaviour
# is chosen by the prompt of each job: "ok", "fail", "die_before_submit", "die_after_submit", "hang".
FAKE_CHILD = textwrap.dedent(
    """
    import json, os, sys, time

    def emit(message):
        sys.stdout.write(json.dumps(message) + "\\n")
        sys.stdout.flush()

    if os.environ.get("FAKE_NEVER_READY"):
        time.sleep(60)
    if os.environ.get("FAKE_EXIT_BEFORE_READY"):
        sys.exit(3)
    emit({"event": "ready"})
    for line in sys.stdin:
        job = json.loads(line)
        if job.get("op") == "stop":
            break
        mode = job["prompt"]
        if mode == "die_before_submit":
            os._exit(1)
        emit({"event": "submitted", "id": job["id"]})
        if mode == "die_after_submit":
            os._exit(1)
        if mode == "hang":
            time.sleep(60)
        if mode == "fail":
            error = {"status": "fail", "error": {"class": "RateLimitError", "detail": "daily limit"}}
            emit({"id": job["id"], "exitCode": 4, "stdout": json.dumps(error)})
        else:
            emit({"id": job["id"], "exitCode": 0, "stdout": ""})
    """
)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make_runner(test, *, env=None, clock=None, rss=lambda _pid: 100.0, **config):
    events = []
    script = Path(tempfile.mkdtemp(prefix="fake-child-")) / "child.py"
    script.write_text(FAKE_CHILD)
    test.addCleanup(lambda: script.unlink(missing_ok=True))

    spawned = []

    def spawn(_scratch):
        import os

        process = subprocess.Popen(
            [sys.executable, str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env={**os.environ, **(env or {})},
        )
        spawned.append(process)
        return process

    kwargs = {"start_timeout_seconds": 5.0, "min_restart_seconds": 0.0, **config}
    runner = warm.WarmRunner(
        config=warm.WarmConfig(**kwargs),
        spawn=spawn,
        event=lambda name, **fields: events.append((name, fields)),
        clock=clock or time.monotonic,
        rss_mb=rss,
    )
    test.addCleanup(runner.shutdown)
    runner.events = events
    runner.spawned = spawned
    return runner


def job(prompt):
    return {"model": "nano-pro", "prompt": prompt, "person": "p", "product": "g", "output": "o", "project": "x"}


class WarmRunnerTest(unittest.TestCase):
    def test_starts_cold_and_serves_jobs_on_one_child(self):
        runner = make_runner(self)
        self.assertEqual(runner.state, warm.COLD)

        first = runner.run(job("ok"), 10)
        self.assertEqual((first.kind, first.exit_code, first.submitted), ("done", 0, True))
        self.assertEqual(runner.state, warm.WARM)
        pid = runner._child.process.pid

        second = runner.run(job("ok"), 10)
        self.assertEqual(second.exit_code, 0)
        self.assertEqual(runner._child.process.pid, pid)
        self.assertEqual(runner.status()["jobs"], 2)
        self.assertEqual([e[0] for e in runner.events].count("flow_warm.started"), 1)

    def test_a_job_failure_is_returned_as_gflow_reports_it_and_recycles_the_browser(self):
        runner = make_runner(self)
        outcome = runner.run(job("fail"), 10)
        self.assertEqual((outcome.kind, outcome.exit_code), ("done", 4))
        self.assertEqual(json.loads(outcome.stdout)["error"]["class"], "RateLimitError")
        first_pid = runner._child.process.pid

        runner.maintain()
        self.assertEqual(runner.state, warm.COLD)

        runner.run(job("ok"), 10)
        self.assertNotEqual(runner._child.process.pid, first_pid)

    def test_a_browser_that_cannot_start_is_unavailable_so_the_caller_can_fall_back(self):
        runner = make_runner(self, env={"FAKE_EXIT_BEFORE_READY": "1"})
        self.assertEqual(runner.run(job("ok"), 10).kind, "unavailable")
        self.assertEqual(runner.state, warm.COLD)
        self.assertIn(("flow_warm.start_failed", {"reason": "exited"}), runner.events)

    def test_a_browser_that_never_becomes_ready_is_unavailable_after_the_start_timeout(self):
        runner = make_runner(self, env={"FAKE_NEVER_READY": "1"}, start_timeout_seconds=0.3)
        started = time.monotonic()
        self.assertEqual(runner.run(job("ok"), 10).kind, "unavailable")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(runner.state, warm.COLD)

    def test_dying_before_the_submit_is_unavailable_but_after_it_is_a_failure(self):
        before = make_runner(self)
        self.assertEqual(before.run(job("die_before_submit"), 10).kind, "unavailable")

        after = make_runner(self)
        outcome = after.run(job("die_after_submit"), 10)
        # The submit may have spent quota, so the caller must not run it again.
        self.assertEqual((outcome.kind, outcome.exit_code, outcome.submitted), ("done", 1, True))
        self.assertEqual(after.state, warm.COLD)

    def test_the_request_budget_ends_a_hung_job_and_releases_the_browser(self):
        runner = make_runner(self)
        outcome = runner.run(job("hang"), 1.0)
        self.assertEqual((outcome.kind, outcome.exit_code, outcome.submitted), ("timeout", 124, True))
        self.assertEqual(runner.state, warm.COLD)

    def test_idle_browser_is_released_after_the_idle_period(self):
        clock = FakeClock()
        runner = make_runner(self, clock=clock, idle_seconds=1800)
        runner.run(job("ok"), 10)

        clock.now += 1799
        runner.maintain()
        self.assertEqual(runner.state, warm.WARM)

        clock.now += 2
        runner.maintain()
        self.assertEqual(runner.state, warm.COLD)
        self.assertIn(("flow_warm.stopped", {"reason": "idle", "jobs": "1"}), runner.events)

    def test_recycled_after_max_jobs(self):
        runner = make_runner(self, max_jobs=2)
        runner.run(job("ok"), 10)
        runner.maintain()
        self.assertEqual(runner.state, warm.WARM)
        runner.run(job("ok"), 10)
        runner.maintain()
        self.assertEqual(runner.state, warm.COLD)
        self.assertIn("max_jobs", [fields.get("reason") for _name, fields in runner.events])

    def test_recycled_when_the_process_tree_holds_too_much_memory(self):
        runner = make_runner(self, rss=lambda _pid: 1300.0, max_rss_mb=1200)
        runner.run(job("ok"), 10)
        runner.maintain()
        self.assertEqual(runner.state, warm.COLD)
        self.assertIn("max_rss", [fields.get("reason") for _name, fields in runner.events])

    def test_recycled_when_too_old(self):
        clock = FakeClock()
        runner = make_runner(self, clock=clock, max_age_seconds=3600)
        runner.run(job("ok"), 10)
        clock.now += 3601
        runner.maintain()
        self.assertEqual(runner.state, warm.COLD)

    def test_warm_starts_in_the_background_and_is_throttled(self):
        runner = make_runner(self, min_restart_seconds=3600)
        self.assertEqual(runner.warm(), "starting")
        deadline = time.monotonic() + 5
        while runner.state != warm.WARM and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(runner.state, warm.WARM)
        self.assertEqual(runner.warm(), warm.WARM)

        runner.stop("test")
        # Started a moment ago: a second warm-up inside the minimum interval is refused.
        self.assertEqual(runner.warm(), warm.COLD)

    def test_stop_releases_the_child_and_its_scratch_directory(self):
        runner = make_runner(self)
        runner.run(job("ok"), 10)
        scratch = runner._child.scratch
        process = runner._child.process
        runner.stop("test")
        self.assertIsNotNone(process.poll())
        self.assertFalse(Path(scratch).exists())

    def test_process_tree_memory_reads_proc_without_failing(self):
        self.assertGreaterEqual(warm.process_tree_rss_mb(1), 0.0)
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        self.addCleanup(process.kill)
        self.addCleanup(process.wait)
        # A process that has only just been spawned has not loaded Python yet; give it a moment.
        deadline = time.monotonic() + 5
        while warm.process_tree_rss_mb(process.pid) <= 1.0 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertGreater(warm.process_tree_rss_mb(process.pid), 1.0)


class CoolBarrierTest(unittest.TestCase):
    """`cool` is the barrier operator work (gflow auth login/status) relies on to have the profile alone."""

    def test_a_warm_start_scheduled_before_a_cool_never_starts_chrome_after_it(self):
        runner = make_runner(self)
        release, finished = threading.Event(), threading.Event()
        scheduled = runner._warm_in_background

        def wakes_up_late(epoch):
            release.wait(5)
            scheduled(epoch)
            finished.set()

        with patch.object(runner, "_warm_in_background", wakes_up_late):
            self.assertEqual(runner.warm(), "starting")
        self.assertTrue(runner.cool(timeout=2))  # nothing is running yet, so this returns at once

        release.set()  # now the scheduled start gets its turn
        self.assertTrue(finished.wait(5))
        self.assertEqual(runner.spawned, [])
        self.assertEqual(runner.state, warm.COLD)

    def test_no_warm_hint_or_request_starts_chrome_while_the_pause_lasts_and_they_do_afterwards(self):
        clock = FakeClock()
        runner = make_runner(self, clock=clock, cool_pause_seconds=900)
        self.assertTrue(runner.cool(timeout=2))

        self.assertEqual(runner.warm(), "paused")
        self.assertEqual(runner.status(), {"state": warm.COLD, "paused": True})
        # A shopper's request is not refused: it is told to use its own gflow process instead.
        self.assertEqual(runner.run(job("ok"), 10).kind, "unavailable")
        self.assertEqual(runner.spawned, [])

        clock.now += 901
        self.assertEqual(runner.status(), {"state": warm.COLD, "paused": False})
        self.assertEqual(runner.run(job("ok"), 10).kind, "done")
        self.assertEqual(len(runner.spawned), 1)

    def test_cool_ends_a_start_in_progress_instead_of_waiting_for_chrome_to_finish_starting(self):
        # The child never reports ready and the start timeout is 30 s: cool must not wait for it.
        runner = make_runner(self, env={"FAKE_NEVER_READY": "1"}, start_timeout_seconds=30)
        self.assertEqual(runner.warm(), "starting")
        deadline = time.monotonic() + 5
        while not runner.spawned and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(runner.spawned), 1)

        started = time.monotonic()
        self.assertTrue(runner.cool(timeout=5))
        self.assertLess(time.monotonic() - started, 3)
        # The process holding the profile is gone by the time cool says it is released.
        self.assertIsNotNone(runner.spawned[0].poll())
        self.assertIn(("flow_warm.start_failed", {"reason": "cancelled"}), runner.events)

    def test_cool_reports_failure_when_the_browser_cannot_be_released_in_time(self):
        runner = make_runner(self)
        holding, release = threading.Event(), threading.Event()

        def hold_the_lock():
            with runner._lock:
                holding.set()
                release.wait(5)

        thread = threading.Thread(target=hold_the_lock)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(release.set)
        self.assertTrue(holding.wait(5))

        self.assertFalse(runner.cool(timeout=0.1))
        # Even so no new start is allowed: the pause was set before waiting for the lock.
        self.assertEqual(runner.warm(), "paused")

    def test_a_per_request_gflow_keeps_the_browser_down_for_as_long_as_it_runs(self):
        runner = make_runner(self)
        runner.run(job("ok"), 10)
        self.assertEqual(runner.state, warm.WARM)

        with runner.exclusive():
            self.assertEqual(runner.state, warm.COLD)
            self.assertEqual(runner.warm(), "paused")
            self.assertEqual(runner.run(job("ok"), 10).kind, "unavailable")
            self.assertEqual(len(runner.spawned), 1)

        self.assertEqual(runner.run(job("ok"), 10).kind, "done")
        self.assertEqual(len(runner.spawned), 2)


class CoolEndpointTest(unittest.TestCase):
    TOKEN = "t" * 40

    def setUp(self):
        self.runner = make_runner(self)
        for target in (
            patch.object(server, "_warm_runner", self.runner),
            patch.object(server, "TOKEN", self.TOKEN),
            patch.object(server, "_profile_present", return_value=True),
        ):
            target.start()
            self.addCleanup(target.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def post_cool(self, token=None, path="/v1/cool"):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=20)
        headers = {"authorization": f"Bearer {token or self.TOKEN}"}
        connection.request("POST", path, headers=headers)
        response = connection.getresponse()
        body = json.loads(response.read())
        connection.close()
        return response.status, body

    def test_cool_releases_the_warm_browser_and_says_so(self):
        self.runner.run(job("ok"), 10)
        self.assertEqual(self.runner.state, warm.WARM)
        self.assertEqual(self.post_cool(), (200, {"ok": True, "state": "cold"}))
        self.assertEqual(self.runner.state, warm.COLD)
        self.assertEqual(self.runner.warm(), "paused")

    def test_cool_answers_busy_when_the_browser_could_not_be_released(self):
        with patch.object(self.runner, "cool", return_value=False):
            self.assertEqual(self.post_cool(), (409, {"ok": False, "reason": "BUSY"}))

    def test_cool_answers_busy_while_a_generation_is_running(self):
        with server._generation_lock:
            self.assertEqual(self.post_cool(), (409, {"ok": False, "reason": "BUSY"}))

    def test_resume_ends_the_pause_early_so_the_browser_can_warm_again(self):
        self.assertEqual(self.post_cool()[0], 200)
        self.assertEqual(self.runner.warm(), "paused")
        self.assertEqual(self.post_cool(path="/v1/resume"), (200, {"ok": True, "state": "cold"}))
        self.assertEqual(self.runner.warm(), "starting")

    def test_resume_needs_the_worker_token(self):
        status, body = self.post_cool(token="x" * 40, path="/v1/resume")
        self.assertEqual((status, body["reason"]), (401, "AUTH_FAILED"))

    def test_cool_needs_the_worker_token(self):
        status, body = self.post_cool(token="x" * 40)
        self.assertEqual((status, body["reason"]), (401, "AUTH_FAILED"))
        self.assertEqual(self.runner.spawned, [])


class ServerWarmIntegrationTest(unittest.TestCase):
    def setUp(self):
        for target in (
            patch.object(server, "_project_id", PROJECT_ID),
            patch.object(server, "_command", return_value=[sys.executable, "-c", "raise SystemExit(5)"]),
        ):
            target.start()
            self.addCleanup(target.stop)
        self.root = Path(tempfile.mkdtemp(prefix="warm-server-"))

    def run_model(self):
        return server._run_model(
            "nano-pro", self.root / "p.jpg", self.root / "g.jpg", self.root / "r.png", 10, self.root / "db"
        )

    def test_without_a_warm_browser_the_request_runs_as_its_own_gflow_process(self):
        with patch.object(server, "_warm_runner", None):
            exit_code, _error = self.run_model()
        self.assertEqual(exit_code, 5)

    def test_gflow_errors_from_the_warm_browser_reach_the_same_failure_mapping(self):
        runner = make_runner(self)
        error = {"status": "fail", "error": {"class": "RateLimitError", "detail": "daily limit"}}
        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(runner, "run", return_value=warm.WarmOutcome("done", 4, json.dumps(error))),
        ):
            exit_code, machine_error = self.run_model()
        self.assertEqual(exit_code, 4)
        self.assertEqual(machine_error.error_class, "RateLimitError")
        self.assertEqual(server._failure_reason(exit_code, machine_error), (429, "BUSY"))

    def test_an_unavailable_warm_browser_falls_back_to_the_per_request_process(self):
        runner = make_runner(self)
        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(runner, "run", return_value=warm.WarmOutcome("unavailable")),
        ):
            exit_code, _error = self.run_model()
        self.assertEqual(exit_code, 5)

    def test_a_warm_timeout_is_the_worker_timeout_and_does_not_fall_back(self):
        runner = make_runner(self)
        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(runner, "run", return_value=warm.WarmOutcome("timeout", 124)),
        ):
            exit_code, _error = self.run_model()
        self.assertEqual(exit_code, server.WORKER_TIMEOUT_EXIT_CODE)

    def test_a_per_request_gflow_first_releases_the_warm_browser(self):
        runner = make_runner(self)
        runner.run(job("ok"), 10)
        self.assertEqual(runner.state, warm.WARM)
        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(server, "_clean_stale_profile_locks"),
        ):
            server._run_gflow([sys.executable, "-c", "pass"], 10, self.root / "db")
        self.assertEqual(runner.state, warm.COLD)

    def test_a_failed_warm_start_leaves_the_fallback_only_what_is_left_of_the_request_budget(self):
        runner = make_runner(self)
        clock = FakeClock()
        gflow_timeouts = []

        def warm_start_fails_after_90_seconds(_job, _budget):
            clock.now += 90
            return warm.WarmOutcome("unavailable")

        def run_gflow(_args, timeout, _db):
            gflow_timeouts.append(timeout)
            return 5, ""

        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(server, "_monotonic", clock),
            patch.object(runner, "run", side_effect=warm_start_fails_after_90_seconds),
            patch.object(server, "_run_gflow", side_effect=run_gflow),
        ):
            exit_code, _error = server._run_model(
                "nano-pro", self.root / "p.jpg", self.root / "g.jpg", self.root / "r.png", 120, self.root / "db"
            )

        # 120 s was available; the warm start spent 90 of them; the per-request gflow gets the other 30.
        self.assertEqual(gflow_timeouts, [30])
        self.assertEqual(exit_code, 5)

    def test_when_the_warm_start_used_the_whole_budget_no_second_generation_is_launched(self):
        runner = make_runner(self)
        clock = FakeClock()

        def warm_start_fails_at_the_deadline(_job, _budget):
            clock.now += 120
            return warm.WarmOutcome("unavailable")

        with (
            patch.object(server, "_warm_runner", runner),
            patch.object(server, "_monotonic", clock),
            patch.object(runner, "run", side_effect=warm_start_fails_at_the_deadline),
            patch.object(server, "_run_gflow", side_effect=AssertionError("must not launch gflow")),
        ):
            exit_code, _error = server._run_model(
                "nano-pro", self.root / "p.jpg", self.root / "g.jpg", self.root / "r.png", 120, self.root / "db"
            )

        self.assertEqual(exit_code, server.WORKER_TIMEOUT_EXIT_CODE)
        self.assertEqual(server._failure_reason(exit_code, server.GflowMachineError()), (504, "TIMEOUT"))

    def test_the_job_carries_the_project_and_files_but_no_token(self):
        runner = make_runner(self)
        seen = {}

        def run(sent, _budget):
            seen.update(sent)
            return warm.WarmOutcome("done", 0)

        with patch.object(server, "_warm_runner", runner), patch.object(runner, "run", side_effect=run):
            self.run_model()
        self.assertEqual(seen["project"], PROJECT_ID)
        self.assertEqual(seen["model"], "nano-pro")
        self.assertEqual(seen["prompt"], server.TRY_ON_PROMPT)
        self.assertNotIn("token", json.dumps(seen).lower())


if __name__ == "__main__":
    unittest.main()
