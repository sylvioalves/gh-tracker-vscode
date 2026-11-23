#!/usr/bin/env python3
"""UserPromptSubmit hook: record which Claude session works on which PR.

On a prompt that starts with /pr-rev, /fresh, /findings or /pr-post,
append one JSON line {ts, session_id, cwd, skill, repo, number} to the
session index read by the PR Deck extension. A command without a PR
argument inherits the PR of the session's previous entry. Prints
nothing and always exits 0, so it never blocks a prompt.
"""
import fcntl
import json
import os
import re
import sys
from datetime import datetime, timezone

SKILLS = ("pr-rev", "fresh", "findings", "pr-post")
DEFAULT_OWNER = "zephyrproject-rtos"
DEFAULT_REPO = "zephyrproject-rtos/zephyr"
INDEX = os.environ.get(
    "PR_SESSION_INDEX",
    os.path.expanduser("~/.claude/reviews/sessions.jsonl"))

COMMAND_RE = re.compile(r"^\s*/(" + "|".join(re.escape(s) for s in SKILLS) + r")(?=\s|$)(.*)$", re.S)
URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
FULL_RE = re.compile(r"(?<![\w/.-])([\w.-]+/[\w.-]+)#(\d+)\b")
SHORT_RE = re.compile(r"(?<![\w/.-])([\w.-]+)#(\d+)\b")
NUMBER_RE = re.compile(r"(?<![\w#=/.-])#?(\d{2,7})(?![\w.])")


def parse_pr(args):
    for regex, fix in ((URL_RE, None), (FULL_RE, None), (SHORT_RE, DEFAULT_OWNER)):
        m = regex.search(args)
        if m:
            repo = f"{fix}/{m.group(1)}" if fix else m.group(1)
            return repo, int(m.group(2))
    m = NUMBER_RE.search(args)
    if m:
        return DEFAULT_REPO, int(m.group(1))
    return None


def last_for_session(session_id):
    try:
        with open(INDEX, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("session_id") == session_id:
            return e.get("repo"), e.get("number")
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    prompt = payload.get("prompt") or ""
    session_id = payload.get("session_id") or ""
    m = COMMAND_RE.match(prompt)
    if not m or not session_id:
        return
    pr = parse_pr(m.group(2)) or last_for_session(session_id)
    if not pr or not pr[0] or not pr[1]:
        return
    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": session_id,
        "cwd": payload.get("cwd") or os.getcwd(),
        "skill": m.group(1),
        "repo": pr[0],
        "number": int(pr[1]),
    }
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    with open(INDEX, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(entry) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
