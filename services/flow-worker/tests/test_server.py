import unittest
from unittest.mock import patch

from flow_worker import server


PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"


class WorkerGenerationPolicyTest(unittest.TestCase):
    def test_pro_success_does_not_touch_nano2(self):
        calls = []

        def run(model, _person, _product, output):
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

        def run(model, _person, _product, output):
            calls.append(model)
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
        self.assertEqual(model, "nano-banana-2")
        self.assertEqual(image, PNG)
        self.assertEqual(mime, "image/png")

    def test_generic_rate_limit_does_not_fallback(self):
        calls = []

        def run(model, _person, _product, _output):
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
