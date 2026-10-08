import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flow_worker import server


PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"
PROJECT_ID = "66666666-6666-4666-8666-666666666666"


def with_project(test_case):
    """Resolve the fixed try-on project for this test without running gflow."""
    for target in (
        patch.object(server, "_project_id", PROJECT_ID),
        patch.object(server, "_ensure_project", return_value=(0, server.GflowMachineError())),
    ):
        target.start()
        test_case.addCleanup(target.stop)


class WorkerGenerationPolicyTest(unittest.TestCase):
    def setUp(self):
        with_project(self)

    def test_pro_success_does_not_touch_nano2(self):
        calls = []

        def run(model, _person, _product, output, _timeout, _db_path):
            calls.append(model)
            output.write_bytes(PNG)
            return 0, server.GflowMachineError()

        with patch.object(server, "_run_model", side_effect=run):
            model, image, mime = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\xff\xd8\xffgarment",
                "image/jpeg",
            )

        self.assertEqual(calls, ["nano-pro"])
        self.assertEqual(model, "nano-banana-pro")
        self.assertEqual(image, PNG)
        self.assertEqual(mime, "image/png")

    def test_daily_pro_quota_exhaustion_falls_back_exactly_once_to_nano_banana_2_1(self):
        calls = []
        db_paths = []

        def run(model, _person, _product, output, _timeout, db_path):
            calls.append(model)
            db_paths.append(db_path)
            if model == "nano-pro":
                return 4, server.GflowMachineError(
                    detail="You have reached the daily limit for Nano Banana Pro."
                )
            output.write_bytes(PNG)
            return 0, server.GflowMachineError()

        with patch.object(server, "_run_model", side_effect=run):
            model, image, mime = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\x89PNG\r\n\x1a\ngarment",
                "image/png",
            )

        self.assertEqual(calls, ["nano-pro", "nano2"])
        self.assertEqual(db_paths[0], db_paths[1])
        self.assertEqual(model, "nano-banana-2.1")
        self.assertEqual(image, PNG)
        self.assertEqual(mime, "image/png")

    def test_ref_filenames_are_short_and_stable_across_fallback(self):
        refs = []

        def run(model, person, product, output, _timeout, _db_path):
            refs.append((model, person.name, product.name))
            if model == "nano-pro" and len(refs) == 1:
                return 4, server.GflowMachineError(
                    detail="You have reached the daily limit for Nano Banana Pro."
                )
            output.write_bytes(PNG)
            return 0, server.GflowMachineError()

        with patch.object(server, "_run_model", side_effect=run):
            for _ in range(2):
                server._generate(
                    b"\xff\xd8\xffperson",
                    "image/jpeg",
                    b"\x89PNG\r\n\x1a\ngarment",
                    "image/png",
                )

        # Request 1: Pro -> Nano2 fallback keeps the same ref filenames. Request 2: Pro only.
        self.assertEqual([r[0] for r in refs], ["nano-pro", "nano2", "nano-pro"])
        self.assertEqual(refs[0][1:], refs[1][1:])
        self.assertEqual(refs[0][1], "person.jpg")
        self.assertEqual(refs[0][2], "garment.png")

    def test_pro_and_nano2_share_one_generation_budget(self):
        timeouts = []

        def run(model, _person, _product, output, timeout, _db_path):
            timeouts.append((model, timeout))
            if model == "nano-pro":
                return 4, server.GflowMachineError(
                    detail="You have reached the daily limit for Nano Banana Pro."
                )
            output.write_bytes(PNG)
            return 0, server.GflowMachineError()

        with (
            patch.object(server, "_run_model", side_effect=run),
            patch.object(server.time, "monotonic", side_effect=[100.0, 100.5, 101.0, 120.0]),
        ):
            result = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\xff\xd8\xffgarment",
                "image/jpeg",
            )

        self.assertEqual(result[0], "nano-banana-2.1")
        self.assertEqual(timeouts, [("nano-pro", 119.0), ("nano2", 100.0)])

    def test_any_rate_limit_falls_back_once_and_a_limited_2_1_reports_busy(self):
        calls = []

        def run(model, _person, _product, _output, _timeout, _db_path):
            calls.append(model)
            return 4, server.GflowMachineError(detail="Rate limit or quota hit: per-minute")

        with patch.object(server, "_run_model", side_effect=run):
            with self.assertRaises(server.WorkerGenerationError) as raised:
                server._generate(
                    b"\xff\xd8\xffperson",
                    "image/jpeg",
                    b"\xff\xd8\xffgarment",
                    "image/jpeg",
                )

        self.assertEqual(calls, ["nano-pro", "nano2"])
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.reason, "BUSY")

    def test_safety_refusal_never_falls_back(self):
        calls = []

        def run(model, _person, _product, _output, _timeout, _db_path):
            calls.append(model)
            return 5, server.GflowMachineError(detail="Content policy blocked this image")

        with patch.object(server, "_run_model", side_effect=run):
            with self.assertRaises(server.WorkerGenerationError) as raised:
                server._generate(b"\xff\xd8\xffp", "image/jpeg", b"\xff\xd8\xffg", "image/jpeg")

        self.assertEqual(calls, ["nano-pro"])
        self.assertEqual(raised.exception.reason, "SAFETY_BLOCKED")

    def test_gflow_child_environment_drops_worker_bearer_token_and_scopes_catalog(self):
        db_path = server.Path("/tmp/flow-try-on-request/gflow.db")
        with patch.dict(server.os.environ, {"FLOW_WORKER_TOKEN": "worker-secret", "PATH": "/usr/bin"}, clear=True):
            env = server._gflow_env(db_path)
        self.assertNotIn("FLOW_WORKER_TOKEN", env)
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["GFLOW_CLI_HEADLESS"], "false")
        self.assertEqual(env["GFLOW_CLI_HISTORY_PROMPTS"], "redacted")
        self.assertEqual(env["GFLOW_CLI_DB_PATH"], str(db_path))
        self.assertNotEqual(env["GFLOW_CLI_DB_PATH"], "/data/gflow/gflow.db")

    def test_generation_catalog_lives_in_request_tempdir_and_is_removed(self):
        db_paths = []

        def run(_model, _person, _product, output, _timeout, db_path):
            db_paths.append(db_path)
            output.write_bytes(PNG)
            return 0, server.GflowMachineError()

        with patch.object(server, "_run_model", side_effect=run):
            result = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\xff\xd8\xffgarment",
                "image/jpeg",
            )

        self.assertEqual(result[0], "nano-banana-pro")
        self.assertEqual(len(db_paths), 1)
        self.assertEqual(db_paths[0].name, "gflow.db")
        self.assertIn("flow-try-on-", db_paths[0].parent.name)
        self.assertFalse(db_paths[0].parent.exists())

    def test_machine_error_parses_stable_json_identity_not_generic_remediation(self):
        stdout = """{
          "status": "fail",
          "error": {
            "type": "https://gflow-cli.dev/errors/rate-limit",
            "class": "RateLimitError",
            "detail": "You have reached the daily limit for Nano Banana Pro.",
            "remediation_hint": "Daily or per-minute model quota reached; try another model"
          }
        }"""
        error = server._machine_error(stdout)
        self.assertEqual(error.detail, "You have reached the daily limit for Nano Banana Pro.")
        self.assertEqual(error.error_class, "RateLimitError")
        self.assertEqual(error.problem_type, "https://gflow-cli.dev/errors/rate-limit")
        self.assertTrue(server.should_fallback_from_pro(4, error.detail))

    def test_profile_locked_json_maps_to_busy_but_other_exit_11_does_not(self):
        locked = server._machine_error(
            """{
              "status": "fail",
              "error": {
                "type": "https://gflow-cli.dev/errors/profile-locked",
                "class": "ProfileLockedError",
                "exit_code": 11,
                "detail": "profile is in use"
              }
            }"""
        )
        generic_config = server._machine_error(
            """{
              "status": "fail",
              "error": {
                "type": "https://gflow-cli.dev/errors/configuration",
                "class": "ConfigurationError",
                "exit_code": 11,
                "detail": "bad configuration"
              }
            }"""
        )
        wrong_type = server._machine_error(
            """{
              "status": "fail",
              "error": {
                "type": "https://gflow-cli.dev/errors/configuration",
                "class": "ProfileLockedError",
                "exit_code": 11,
                "detail": "profile is in use"
              }
            }"""
        )

        self.assertEqual(server._failure_reason(11, locked), (409, "BUSY"))
        self.assertEqual(server._failure_reason(11, generic_config), (502, "GENERATION_FAILED"))
        self.assertEqual(server._failure_reason(11, wrong_type), (502, "GENERATION_FAILED"))

    def test_verified_gflow_exit_codes_map_without_scraping_error_text(self):
        self.assertEqual(server._failure_reason(3), (401, "AUTH_FAILED"))
        self.assertEqual(server._failure_reason(8), (401, "AUTH_FAILED"))
        self.assertEqual(server._failure_reason(4), (429, "BUSY"))
        self.assertEqual(server._failure_reason(5), (422, "SAFETY_BLOCKED"))
        self.assertEqual(server._failure_reason(9), (504, "TIMEOUT"))
        self.assertEqual(server._failure_reason(server.WORKER_TIMEOUT_EXIT_CODE), (504, "TIMEOUT"))
        self.assertEqual(server._failure_reason(10), (502, "GENERATION_FAILED"))
        self.assertEqual(server._failure_reason(11), (502, "GENERATION_FAILED"))
        self.assertEqual(server._failure_reason(23), (502, "GENERATION_FAILED"))

    def test_command_pins_two_refs_one_output_and_requested_model(self):
        command = server._command(
            "nano-pro",
            server.Path("/tmp/person.jpg"),
            server.Path("/tmp/garment.png"),
            server.Path("/tmp/result.png"),
        )
        self.assertEqual(command[:5], [sys.executable, "-m", "flow_worker.gflow_launcher", "image", "i2i"])
        self.assertEqual(command[command.index("i2i") + 1], server.TRY_ON_PROMPT)
        self.assertEqual(command.count("--ref"), 2)
        self.assertIn("nano-pro", command)
        self.assertIn("--count", command)
        self.assertEqual(command[command.index("--count") + 1], "1")
        self.assertEqual(command[command.index("--output") + 1], str(server.Path("/tmp/result.png")))
        self.assertEqual(command[command.index("--project") + 1], PROJECT_ID)
        self.assertNotIn("nano2-lite", command)

    def test_command_refuses_to_run_without_the_fixed_project(self):
        with patch.object(server, "_project_id", None):
            with self.assertRaises(ValueError):
                server._command("nano-pro", Path("/tmp/p.jpg"), Path("/tmp/g.jpg"), Path("/tmp/o.png"))
            self.assertEqual(
                server._run_model("nano-pro", Path("/tmp/p.jpg"), Path("/tmp/g.jpg"), Path("/tmp/o.png"), 10, Path("/tmp/db")),
                (1, server.GflowMachineError()),
            )

    def test_image_boundary_rejects_declared_mime_mismatch(self):
        with self.assertRaises(server.RequestError):
            server._decode_image(
                {
                    "mimeType": "image/jpeg",
                    "imageBase64": "iVBORw0KGgp0ZXN0",
                }
            )



class GflowExitStatusTest(unittest.TestCase):
    def setUp(self):
        with_project(self)

    def test_non_zero_gflow_exit_status_reaches_failure_mapping(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(server, "_command", return_value=[sys.executable, "-c", "raise SystemExit(5)"]):
                exit_code, _ = server._run_model(
                    "nano-pro",
                    root / "person.jpg",
                    root / "garment.jpg",
                    root / "result.png",
                    10,
                    root / "gflow.db",
                )

        self.assertEqual(exit_code, 5)
        self.assertEqual(server._failure_reason(exit_code), (422, "SAFETY_BLOCKED"))

    def test_non_zero_gflow_does_not_log_raw_stderr_or_provider_detail(self):
        machine_stdout = (
            '{"status":"fail","error":{'
            '"type":"https://gflow-cli.dev/errors/reference-not-found",'
            '"class":"ReferenceNotFoundError",'
            '"detail":"provider-secret-detail"}}'
        )
        script = (
            "import sys; "
            f"print({machine_stdout!r}); "
            "print('stderr-secret-token', file=sys.stderr); "
            "raise SystemExit(32)"
        )
        events = []

        def capture(name, **fields):
            events.append((name, fields))

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with (
                patch.object(server, "_command", return_value=[sys.executable, "-c", script]),
                patch.object(server, "_event", side_effect=capture),
            ):
                exit_code, error = server._run_model(
                    "nano-pro",
                    root / "person.jpg",
                    root / "garment.jpg",
                    root / "result.png",
                    10,
                    root / "gflow.db",
                )

        self.assertEqual(exit_code, 32)
        self.assertEqual(error.error_class, "ReferenceNotFoundError")
        self.assertEqual(
            events,
            [
                (
                    "flow_try_on.process_error",
                    {
                        "model": "nano-pro",
                        "exit_code": "32",
                        "error_class": "ReferenceNotFoundError",
                    },
                )
            ],
        )
        rendered_events = repr(events)
        self.assertNotIn("stderr-secret-token", rendered_events)
        self.assertNotIn("provider-secret-detail", rendered_events)


class WireDiagnosticsTest(unittest.TestCase):
    def test_only_enum_tokens_from_the_guard_detail_are_logged(self):
        detail = (
            "FLOW_QUOTA_EXHAUSTED: Flow refused the image submit with RESOURCE_EXHAUSTED "
            "(PUBLIC_ERROR_DAILY_QUOTA) try-on guard: aborted. "
            "WIRE_MODEL_CANDIDATES=NANO_BANANA_2_1,IMAGE_ASPECT_RATIO_PORTRAIT shopper-photo.jpg"
        )
        self.assertEqual(
            server._wire_diagnostics(detail),
            {
                "quota_reasons": "PUBLIC_ERROR_DAILY_QUOTA",
                "wire_model_candidates": "NANO_BANANA_2_1,IMAGE_ASPECT_RATIO_PORTRAIT",
            },
        )
        self.assertEqual(server._wire_diagnostics("provider said something (with text)"), {})


class FixedProjectTest(unittest.TestCase):
    """gflow creates a scratch Flow project for every i2i run without --project."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.db = self.home / "gflow.db"
        self.events = []
        for target in (
            patch.object(server, "GFLOW_HOME", self.home),
            patch.object(server, "_project_id", None),
            patch.object(server, "_unrecorded_project_id", None),
            patch.object(server, "_event", side_effect=lambda name, **fields: self.events.append(name)),
        ):
            target.start()
            self.addCleanup(target.stop)

    def created(self, stdout, returncode=0):
        return patch.object(server, "_run_gflow", return_value=(returncode, stdout))

    def test_first_request_creates_one_project_and_records_it_in_the_gflow_volume(self):
        reply = json.dumps({"status": "ok", "project_id": PROJECT_ID, "title": "LA try-on"})
        with self.created(reply) as run:
            self.assertEqual(server._ensure_project(30, self.db), (0, server.GflowMachineError()))
            self.assertEqual(server._ensure_project(30, self.db), (0, server.GflowMachineError()))

        self.assertEqual(run.call_count, 1)
        args = run.call_args.args[0]
        self.assertEqual(args[3:6], ["project", "create", "--title"])
        self.assertEqual(server._project_id, PROJECT_ID)
        stored = json.loads((self.home / server.PROJECT_STATE_FILE).read_text())
        self.assertEqual(stored["projectId"], PROJECT_ID)
        self.assertEqual(self.events, ["flow_try_on.project_created", "flow_try_on.project_recorded"])

    def test_a_restarted_worker_reuses_the_recorded_project_without_creating_another(self):
        (self.home / server.PROJECT_STATE_FILE).write_text(json.dumps({"projectId": PROJECT_ID}))
        with self.created("") as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 0)

        run.assert_not_called()
        self.assertEqual(server._project_id, PROJECT_ID)

    def test_configured_project_is_used_as_is(self):
        with patch.object(server, "_project_id", "configured-project-1"), self.created("") as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 0)
            self.assertEqual(server._project_id, "configured-project-1")
        run.assert_not_called()

    def test_failed_creation_records_nothing_and_blocks_generation(self):
        failure = json.dumps({"status": "fail", "error": {"class": "AuthMissingError", "detail": "x"}})
        with self.created(failure, returncode=8):
            self.assertEqual(server._ensure_project(30, self.db)[0], 8)
        self.assertIsNone(server._project_id)
        self.assertFalse((self.home / server.PROJECT_STATE_FILE).exists())

        with (
            self.created(failure, returncode=8),
            patch.object(server, "_run_model") as run_model,
        ):
            with self.assertRaises(server.WorkerGenerationError) as raised:
                server._generate(b"\xff\xd8\xffp", "image/jpeg", b"\xff\xd8\xffg", "image/jpeg")
        run_model.assert_not_called()
        self.assertEqual(raised.exception.reason, "AUTH_FAILED")

    def restart(self):
        """A recreated container: same gflow volume, fresh process memory."""
        server._project_id = None
        server._unrecorded_project_id = None

    def test_invalid_reply_is_never_used_and_never_followed_by_a_second_create(self):
        with self.created(json.dumps({"status": "ok", "project_id": "bad id!"})):
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        self.assertIsNone(server._project_id)
        self.restart()
        with self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})) as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        run.assert_not_called()
        self.assertEqual(self.events[-1], "flow_try_on.project_state_invalid")

    def test_restart_after_an_unrecordable_create_never_creates_a_second_project(self):
        reply = json.dumps({"status": "ok", "project_id": PROJECT_ID})
        with self.created(reply), patch.object(server, "_store_project_id", side_effect=OSError("disk")):
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        self.restart()
        with self.created(reply) as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        run.assert_not_called()
        self.assertIsNone(server._project_id)
        state = json.loads((self.home / server.PROJECT_STATE_FILE).read_text())
        self.assertEqual(state["pending"], True)

    def test_restart_after_a_create_that_timed_out_never_creates_a_second_project(self):
        # Flow may have created the project even though gflow never answered.
        with self.created("", returncode=server.WORKER_TIMEOUT_EXIT_CODE):
            self.assertEqual(server._ensure_project(30, self.db)[0], server.WORKER_TIMEOUT_EXIT_CODE)
        self.restart()
        with self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})) as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        run.assert_not_called()

    def test_no_create_runs_when_the_pending_marker_cannot_be_written(self):
        with (
            patch.object(server, "_write_project_state", side_effect=OSError("read-only")),
            self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})) as run,
        ):
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        run.assert_not_called()
        self.assertEqual(self.events, ["flow_try_on.project_record_failed"])

    def test_operator_recorded_id_replaces_the_pending_marker(self):
        state = self.home / server.PROJECT_STATE_FILE
        state.write_text(json.dumps({"pending": True, "title": "LA try-on"}))
        with self.created("") as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        state.write_text(json.dumps({"projectId": PROJECT_ID}))
        with self.created("") as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 0)
        run.assert_not_called()
        self.assertEqual(server._project_id, PROJECT_ID)

    def test_corrupt_or_invalid_record_refuses_generation_without_creating_another_project(self):
        for content in ('{"projectId": "../../etc"}', "{not json", '{"title": "LA try-on"}'):
            with self.subTest(content=content):
                state = self.home / server.PROJECT_STATE_FILE
                state.write_text(content)
                with self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})) as run:
                    self.assertEqual(server._ensure_project(30, self.db)[0], 1)
                run.assert_not_called()
                self.assertIsNone(server._project_id)
                self.assertEqual(state.read_text(), content)
                self.assertEqual(self.events[-1], "flow_try_on.project_state_invalid")

    def test_unreadable_record_refuses_generation_without_creating_another_project(self):
        (self.home / server.PROJECT_STATE_FILE).mkdir()  # exists, but reading it fails
        with self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})) as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
        run.assert_not_called()
        self.assertEqual(self.events, ["flow_try_on.project_state_invalid"])

    def test_unrecordable_project_refuses_generation_and_retries_the_write_not_the_create(self):
        reply = json.dumps({"status": "ok", "project_id": PROJECT_ID})
        with (
            self.created(reply) as run,
            patch.object(server, "_store_project_id", side_effect=OSError("read-only volume")),
            patch.object(server, "_run_model") as run_model,
        ):
            self.assertEqual(server._ensure_project(30, self.db)[0], 1)
            with self.assertRaises(server.WorkerGenerationError):
                server._generate(b"\xff\xd8\xffp", "image/jpeg", b"\xff\xd8\xffg", "image/jpeg")
        self.assertEqual(run.call_count, 1)
        run_model.assert_not_called()
        self.assertIsNone(server._project_id)
        self.assertIn("flow_try_on.project_record_failed", self.events)

        # Once the volume is writable again the same project is recorded; no second create.
        with self.created(reply) as run:
            self.assertEqual(server._ensure_project(30, self.db)[0], 0)
        run.assert_not_called()
        self.assertEqual(server._project_id, PROJECT_ID)
        self.assertEqual(json.loads((self.home / server.PROJECT_STATE_FILE).read_text())["projectId"], PROJECT_ID)

    def test_restarted_worker_after_recording_never_creates_again(self):
        with self.created(json.dumps({"status": "ok", "project_id": PROJECT_ID})):
            server._ensure_project(30, self.db)
        with (
            patch.object(server, "_project_id", None),
            patch.object(server, "_unrecorded_project_id", None),
            self.created("") as run,
        ):
            self.assertEqual(server._ensure_project(30, self.db)[0], 0)
            self.assertEqual(server._project_id, PROJECT_ID)
        run.assert_not_called()


class FakeLease:
    def __init__(self):
        self.released = False

    def release(self):
        self.released = True


@unittest.skipIf(sys.platform == "win32", "os.symlink requires SeCreateSymbolicLinkPrivilege on Windows")
class StaleProfileLockCleanupTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.profile_dir = self.home / "profile_default"
        self.profile_dir.mkdir()
        for name in server.CHROME_SINGLETON_NAMES:
            os.symlink("old-container-41", self.profile_dir / name)
        (self.profile_dir / "SingletonUnrelated").write_text("keep")
        for target in (
            patch.object(server, "GFLOW_HOME", self.home),
            patch.object(server, "PROFILE", "default"),
        ):
            target.start()
            self.addCleanup(target.stop)

    def remaining_links(self):
        return [name for name in server.CHROME_SINGLETON_NAMES if (self.profile_dir / name).is_symlink()]

    def test_removes_only_chrome_singleton_links_when_profile_is_provably_unused(self):
        lease = FakeLease()
        with (
            patch.object(server, "_acquire_profile_lease", return_value=lease),
            patch.object(server, "_chrome_uses_profile", return_value=False),
        ):
            server._clean_stale_profile_locks()

        self.assertEqual(self.remaining_links(), [])
        self.assertTrue((self.profile_dir / "SingletonUnrelated").is_file())
        self.assertTrue(lease.released)

    def test_keeps_links_while_another_gflow_holds_the_profile_lease(self):
        with (
            patch.object(server, "_acquire_profile_lease", return_value=None),
            patch.object(server, "_chrome_uses_profile", return_value=False),
        ):
            server._clean_stale_profile_locks()

        self.assertEqual(self.remaining_links(), list(server.CHROME_SINGLETON_NAMES))

    def test_keeps_links_while_a_chrome_process_still_runs_on_the_profile(self):
        lease = FakeLease()
        with (
            patch.object(server, "_acquire_profile_lease", return_value=lease),
            patch.object(server, "_chrome_uses_profile", return_value=True),
        ):
            server._clean_stale_profile_locks()

        self.assertEqual(self.remaining_links(), list(server.CHROME_SINGLETON_NAMES))
        self.assertTrue(lease.released)

    def test_invalid_profile_name_has_no_side_effects(self):
        with (
            patch.object(server, "PROFILE", "../default"),
            patch.object(server, "_acquire_profile_lease") as acquire,
        ):
            server._clean_stale_profile_locks()

        acquire.assert_not_called()
        self.assertEqual(self.remaining_links(), list(server.CHROME_SINGLETON_NAMES))

    def test_detects_chrome_by_user_data_dir_argument(self):
        with tempfile.TemporaryDirectory() as proc_root:
            proc = Path(proc_root)
            (proc / "17").mkdir()
            (proc / "17" / "cmdline").write_bytes(
                b"/opt/google/chrome/chrome-orig\0--user-data-dir=" + str(self.profile_dir).encode() + b"\0"
            )
            real_path = server.Path

            def fake_path(value, *rest):
                return proc if value == "/proc" and not rest else real_path(value, *rest)

            with patch.object(server, "Path", side_effect=fake_path):
                self.assertTrue(server._chrome_uses_profile(self.profile_dir))
                (proc / "17" / "cmdline").write_bytes(b"/usr/bin/python3\0-m\0flow_worker.server\0")
                self.assertFalse(server._chrome_uses_profile(self.profile_dir))


if __name__ == "__main__":
    unittest.main()
