import unittest
from unittest.mock import patch

from flow_worker import server


PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"


class WorkerGenerationPolicyTest(unittest.TestCase):
    def test_pro_success_does_not_touch_nano2(self):
        calls = []

        def run(model, _person, _product, output, _timeout, _db_path):
            calls.append(model)
            output.write_bytes(PNG)
            return 0, ""

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

    def test_daily_pro_quota_exhaustion_falls_back_exactly_once_to_nano2(self):
        calls = []
        db_paths = []

        def run(model, _person, _product, output, _timeout, db_path):
            calls.append(model)
            db_paths.append(db_path)
            if model == "nano-pro":
                return 4, "You have reached the daily limit for Nano Banana Pro."
            output.write_bytes(PNG)
            return 0, ""

        with patch.object(server, "_run_model", side_effect=run):
            model, image, mime = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\x89PNG\r\n\x1a\ngarment",
                "image/png",
            )

        self.assertEqual(calls, ["nano-pro", "nano2"])
        self.assertEqual(db_paths[0], db_paths[1])
        self.assertEqual(model, "nano-banana-2")
        self.assertEqual(image, PNG)
        self.assertEqual(mime, "image/png")

    def test_pro_and_nano2_share_one_generation_budget(self):
        timeouts = []

        def run(model, _person, _product, output, timeout, _db_path):
            timeouts.append((model, timeout))
            if model == "nano-pro":
                return 4, "You have reached the daily limit for Nano Banana Pro."
            output.write_bytes(PNG)
            return 0, ""

        with (
            patch.object(server, "_run_model", side_effect=run),
            patch.object(server.time, "monotonic", side_effect=[100.0, 101.0, 120.0]),
        ):
            result = server._generate(
                b"\xff\xd8\xffperson",
                "image/jpeg",
                b"\xff\xd8\xffgarment",
                "image/jpeg",
            )

        self.assertEqual(result[0], "nano-banana-2")
        self.assertEqual(timeouts, [("nano-pro", 49.0), ("nano2", 30.0)])

    def test_generic_rate_limit_does_not_fallback(self):
        calls = []

        def run(model, _person, _product, _output, _timeout, _db_path):
            calls.append(model)
            return 4, "Rate limit or quota hit"

        with patch.object(server, "_run_model", side_effect=run):
            with self.assertRaises(server.WorkerGenerationError) as raised:
                server._generate(
                    b"\xff\xd8\xffperson",
                    "image/jpeg",
                    b"\xff\xd8\xffgarment",
                    "image/jpeg",
                )

        self.assertEqual(calls, ["nano-pro"])
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.reason, "BUSY")

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
            return 0, ""

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

    def test_machine_error_detail_reads_detail_not_generic_remediation(self):
        stdout = """{
          "status": "fail",
          "error": {
            "detail": "You have reached the daily limit for Nano Banana Pro.",
            "remediation_hint": "Daily or per-minute model quota reached; try another model"
          }
        }"""
        detail = server._machine_error_detail(stdout)
        self.assertEqual(detail, "You have reached the daily limit for Nano Banana Pro.")
        self.assertTrue(server.should_fallback_to_nano2(4, detail))

    def test_verified_gflow_exit_codes_map_without_scraping_error_text(self):
        self.assertEqual(server._failure_reason(3), (401, "AUTH_FAILED"))
        self.assertEqual(server._failure_reason(8), (401, "AUTH_FAILED"))
        self.assertEqual(server._failure_reason(4), (429, "BUSY"))
        self.assertEqual(server._failure_reason(5), (422, "SAFETY_BLOCKED"))
        self.assertEqual(server._failure_reason(9), (504, "TIMEOUT"))
        self.assertEqual(server._failure_reason(server.WORKER_TIMEOUT_EXIT_CODE), (504, "TIMEOUT"))
        self.assertEqual(server._failure_reason(10), (502, "GENERATION_FAILED"))
        self.assertEqual(server._failure_reason(23), (502, "GENERATION_FAILED"))

    def test_command_pins_two_refs_one_output_and_requested_model(self):
        command = server._command(
            "nano-pro",
            server.Path("/tmp/person.jpg"),
            server.Path("/tmp/garment.png"),
            server.Path("/tmp/result.png"),
        )
        self.assertEqual(command[:3], ["gflow", "image", "i2i"])
        self.assertEqual(command.count("--ref"), 2)
        self.assertIn("nano-pro", command)
        self.assertIn("--count", command)
        self.assertEqual(command[command.index("--count") + 1], "1")
        self.assertEqual(command[command.index("--output") + 1], "/tmp/result.png")
        self.assertNotIn("nano2-lite", command)

    def test_image_boundary_rejects_declared_mime_mismatch(self):
        with self.assertRaises(server.RequestError):
            server._decode_image(
                {
                    "mimeType": "image/jpeg",
                    "imageBase64": "iVBORw0KGgp0ZXN0",
                }
            )


if __name__ == "__main__":
    unittest.main()
