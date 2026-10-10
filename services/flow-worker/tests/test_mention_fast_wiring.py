import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from flow_worker import gflow_prompt_guard as guard
from flow_worker import server

_HERE = Path(__file__).resolve()
# The worker image carries only services/flow-worker, so the deploy files exist only in a repo checkout.
REPO = _HERE.parents[3] if len(_HERE.parents) > 3 else None
COMPOSE = REPO / "deploy" / "vps" / "compose.yml" if REPO else None
ENV_EXAMPLE = REPO / "deploy" / "vps" / "env.example" if REPO else None


class MentionFastSwitchTest(unittest.TestCase):
    def test_enabled_by_default_and_off_for_the_documented_values(self):
        with patch.dict(os.environ, clear=False):
            os.environ.pop("FLOW_MENTION_FAST", None)
            self.assertTrue(guard.fast_mention_enabled())
        for value in ("0", "false", "No", "OFF", " 0 "):
            with patch.dict(os.environ, {"FLOW_MENTION_FAST": value}):
                self.assertFalse(guard.fast_mention_enabled(), value)
        with patch.dict(os.environ, {"FLOW_MENTION_FAST": "1"}):
            self.assertTrue(guard.fast_mention_enabled())

    def test_the_gflow_child_inherits_the_switch(self):
        with patch.dict(os.environ, {"FLOW_MENTION_FAST": "0"}):
            self.assertEqual(server._gflow_env(Path("/tmp/gflow.db"))["FLOW_MENTION_FAST"], "0")


@unittest.skipUnless(
    COMPOSE and COMPOSE.is_file() and ENV_EXAMPLE and ENV_EXAMPLE.is_file(),
    "deploy/vps is not in this tree (worker image); the repo CI runs these",
)
class MentionFastDeployWiringTest(unittest.TestCase):
    """compose.yml gives flow-worker an allowlist, not .env.production, so the switch must be listed."""

    def flow_worker_block(self):
        compose = COMPOSE.read_text(encoding="utf-8")
        match = re.search(r"^  flow-worker:\n(.*?)(?=^  \S|\Z)", compose, re.S | re.M)
        self.assertIsNotNone(match, "flow-worker service not found in compose.yml")
        return match.group(1)

    def test_compose_forwards_the_deploy_variable_with_the_fast_path_on_by_default(self):
        self.assertIn("FLOW_MENTION_FAST: ${LA_TRY_ON_FLOW_MENTION_FAST:-1}", self.flow_worker_block())

    def test_flow_worker_still_does_not_inherit_the_production_env_file(self):
        self.assertNotIn("env_file", self.flow_worker_block())

    def test_the_deploy_env_example_documents_the_switch(self):
        example = ENV_EXAMPLE.read_text(encoding="utf-8")
        self.assertRegex(example, r"(?m)^LA_TRY_ON_FLOW_MENTION_FAST=1$")


if __name__ == "__main__":
    unittest.main()
