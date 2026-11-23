import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pr-session-index.py")
SID = "110cafae-778b-4ec7-8006-7573681a09f5"
OTHER = "220cafae-778b-4ec7-8006-7573681a09f5"


class HookTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.index = os.path.join(self.dir.name, "reviews", "sessions.jsonl")

    def tearDown(self):
        self.dir.cleanup()

    def run_hook(self, prompt, session=SID, raw=None):
        env = dict(os.environ, PR_SESSION_INDEX=self.index)
        stdin = raw if raw is not None else json.dumps(
            {"session_id": session, "cwd": "/w/zephyr", "prompt": prompt, "hook_event_name": "UserPromptSubmit"})
        res = subprocess.run([sys.executable, HOOK], input=stdin, text=True, capture_output=True, env=env)
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout, "")
        return res

    def entries(self):
        if not os.path.exists(self.index):
            return []
        with open(self.index, encoding="utf-8") as f:
            return [json.loads(line) for line in f]

    def last(self):
        e = self.entries()[-1]
        return e["skill"], e["repo"], e["number"]

    def test_pr_reference_forms(self):
        cases = [
            ("/pr-rev https://github.com/zephyrproject-rtos/hal_espressif/pull/702", ("pr-rev", "zephyrproject-rtos/hal_espressif", 702)),
            ("/pr-rev 114959", ("pr-rev", "zephyrproject-rtos/zephyr", 114959)),
            ("/pr-rev #124900 please", ("pr-rev", "zephyrproject-rtos/zephyr", 124900)),
            ("/pr-rev hal_espressif#657", ("pr-rev", "zephyrproject-rtos/hal_espressif", 657)),
            ("/pr-rev mcu-tools/mcuboot#2100", ("pr-rev", "mcu-tools/mcuboot", 2100)),
            ("/pr-post 126199 only=F1,F3 skip=F2", ("pr-post", "zephyrproject-rtos/zephyr", 126199)),
        ]
        for prompt, want in cases:
            with self.subTest(prompt=prompt):
                self.run_hook(prompt)
                self.assertEqual(self.last(), want)
        e = self.entries()[0]
        self.assertEqual(e["session_id"], SID)
        self.assertEqual(e["cwd"], "/w/zephyr")
        self.assertRegex(e["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_command_without_pr_inherits_the_session_pr(self):
        self.run_hook("/pr-rev 114959")
        self.run_hook("/pr-rev 702", session=OTHER)
        self.run_hook("/fresh")
        self.run_hook("/findings")
        self.assertEqual(self.entries()[2]["number"], 114959)
        self.assertEqual(self.last(), ("findings", "zephyrproject-rtos/zephyr", 114959))

    def test_command_without_pr_and_no_history_is_skipped(self):
        self.run_hook("/fresh")
        self.assertEqual(self.entries(), [])

    def test_other_prompts_are_ignored(self):
        for prompt in ["review 114959", "/pr-review 1234", "/cleanup", "/pr-revx 1234", "please /pr-rev 1234"]:
            self.run_hook(prompt)
        self.assertEqual(self.entries(), [])

    def test_broken_input_never_fails(self):
        self.run_hook(None, raw="not json")
        self.run_hook(None, raw=json.dumps({"prompt": "/pr-rev 1234"}))
        self.assertEqual(self.entries(), [])


if __name__ == "__main__":
    unittest.main()
