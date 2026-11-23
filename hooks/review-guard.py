#!/usr/bin/env python3
"""PreToolUse hook: keep pull request review sessions read-only.

A session counts as a review session when CLAUDE_REVIEW_SESSION=1 is
in the environment or when its session id appears in the session
index written by pr-session-index.py, that is, once /pr-rev, /fresh,
/findings or /pr-post ran in it. Other sessions are left alone.

In a review session the pull request text, diff and comments are
untrusted input to the model, so the hook allows only what the review
skills need: read-only shell commands, read-only git and gh
subcommands, the pr-post script, and file writes under the review
ledger directory. Everything else is denied with a reason the model
can relay. Prints a deny decision or nothing, always exits 0.
"""
import json
import os
import re
import shlex
import sys

INDEX = os.environ.get(
    "PR_SESSION_INDEX",
    os.path.expanduser("~/.claude/reviews/sessions.jsonl"))
HOME = os.path.expanduser("~")
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")

WRITE_ROOTS = (
    os.path.join(CLAUDE_DIR, "reviews"),
    os.path.join(CLAUDE_DIR, "tmp"),
    "/var/tmp/claude",
)

SECRET_PATHS = (
    os.path.join(HOME, ".ssh"),
    os.path.join(HOME, ".gnupg"),
    os.path.join(HOME, ".aws"),
    os.path.join(HOME, ".netrc"),
    os.path.join(HOME, ".config", "gh"),
    os.path.join(HOME, ".claude.json"),
    os.path.join(CLAUDE_DIR, ".credentials.json"),
    os.path.join(CLAUDE_DIR, "settings.json"),
    os.path.join(CLAUDE_DIR, "settings.local.json"),
)

READ_ONLY = {
    "cat", "head", "tail", "less", "more", "wc", "ls", "find", "grep", "rg",
    "egrep", "fgrep", "sort", "uniq", "cut", "tr", "diff", "cmp", "file",
    "stat", "du", "which", "type", "echo", "printf", "pwd", "true", "false",
    "test", "[", "jq", "basename", "dirname", "realpath", "readlink", "date",
    "column", "nl", "tac", "rev", "fold", "paste", "comm", "md5sum",
    "sha256sum", "sha1sum", "tree", "cd", "sed", "awk", "gawk", "xargs",
}

GIT_READ = {
    "show", "log", "diff", "range-diff", "rev-parse", "rev-list", "ls-tree",
    "ls-files", "cat-file", "blame", "status", "merge-base", "describe",
    "name-rev", "grep", "shortlog", "for-each-ref", "show-ref", "version",
    "diff-tree", "check-attr", "check-ignore", "ls-remote",
}

GIT_GLOBAL_EXEC = ("-c", "--config-env", "--exec-path")
GIT_SUB_EXEC = ("--upload-pack", "--receive-pack", "--exec", "--output", "-O",
                "--open-files-in-pager", "--refmap", "--update-head-ok")

GH_READ = {
    ("pr", "view"), ("pr", "diff"), ("pr", "checks"), ("pr", "status"), ("pr", "list"),
    ("issue", "view"), ("issue", "list"), ("run", "view"), ("run", "list"),
    ("repo", "view"), ("label", "list"), ("search", None), ("--version", None),
}

GH_API_WRITE = ("-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "--hostname")

ALLOWED_HOSTS = ("github.com", "api.github.com", "raw.githubusercontent.com", "docs.zephyrproject.org")

POST_SCRIPT = os.path.join(CLAUDE_DIR, "skills", "pr-post", "post.py")

SEPARATORS = {"|", "||", "&&", ";", "&", ";;"}
REDIRECT_OUT = {">", ">>", "&>", "&>>", ">|"}


class Deny(Exception):
    pass


def norm(path):
    path = os.path.expanduser(path.replace("${HOME}", HOME).replace("$HOME", HOME))
    return os.path.normpath(os.path.join(os.getcwd(), path)) if path else path


def under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def is_review_session(payload):
    if os.environ.get("CLAUDE_REVIEW_SESSION") == "1":
        return True
    sid = payload.get("session_id")
    if not sid:
        return False
    try:
        with open(INDEX, encoding="utf-8") as f:
            for line in f:
                try:
                    if json.loads(line).get("session_id") == sid:
                        return True
                except ValueError:
                    continue
    except OSError:
        pass
    return False


def check_write(path):
    if not path:
        raise Deny("review session: file writes need a path")
    p = norm(path)
    if not any(under(p, root) for root in WRITE_ROOTS):
        roots = ", ".join(WRITE_ROOTS)
        raise Deny(f"review session: writes are limited to {roots}. A review only takes notes in its ledger, start a new session to change code or settings.")


def check_secret_paths(tokens):
    for tok in tokens:
        if not tok or tok.startswith("-"):
            continue
        p = norm(tok)
        for secret in SECRET_PATHS:
            if under(p, secret):
                raise Deny(f"review session: {secret} holds credentials or settings and is not readable here")


def lex(command):
    lx = shlex.shlex(command.replace("\n", ";"), posix=True, punctuation_chars=True)
    lx.whitespace_split = True
    try:
        return list(lx)
    except ValueError:
        raise Deny("review session: could not parse the command, simplify the quoting")


def split_commands(tokens):
    commands = []
    argv = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if tok in SEPARATORS:
            if argv:
                commands.append(argv)
            argv = []
        elif tok in ("(", ")", "((", "))"):
            raise Deny("review session: subshells and command substitution are not allowed, run the inner command on its own")
        elif "`" in tok or "$(" in tok:
            raise Deny("review session: command substitution is not allowed, run the inner command on its own")
        elif tok in ("<<", "<<-"):
            raise Deny("review session: here-documents are not allowed")
        elif tok == ">&" or re.fullmatch(r"\d>&", tok):
            if nxt is None or not nxt.isdigit():
                raise Deny("review session: output redirection to a file is not allowed, only 2>&1 and /dev/null")
            if argv and argv[-1].isdigit() and tok == ">&":
                argv.pop()
            i += 1
        elif tok in REDIRECT_OUT or re.fullmatch(r"\d>>?", tok):
            if nxt != "/dev/null":
                raise Deny("review session: output redirection to a file is not allowed, only 2>&1 and /dev/null")
            if argv and argv[-1].isdigit() and tok in REDIRECT_OUT:
                argv.pop()
            i += 1
        elif tok in ("<", "<<<", "<>"):
            if tok == "<>":
                raise Deny("review session: output redirection to a file is not allowed, only 2>&1 and /dev/null")
            if nxt is not None:
                check_secret_paths([nxt])
            i += 1
        else:
            argv.append(tok)
        i += 1
    if argv:
        commands.append(argv)
    return commands


def check_git(argv):
    args = argv[1:]
    i = 0
    while i < len(args) and args[i].startswith("-"):
        opt = args[i]
        if opt.split("=")[0] in GIT_GLOBAL_EXEC:
            raise Deny(f"review session: git {opt} can run commands and is not allowed")
        if opt in ("-C", "--git-dir", "--work-tree", "--namespace"):
            i += 1
        i += 1
    if i >= len(args):
        raise Deny("review session: bare git is not allowed")
    sub = args[i]
    rest = args[i + 1:]
    for opt in rest:
        if opt.split("=")[0] in GIT_SUB_EXEC:
            raise Deny(f"review session: git {sub} {opt} runs a program or writes a file and is not allowed")
    if sub in GIT_READ:
        return
    if sub == "fetch":
        for spec in rest:
            if ":" in spec and not spec.startswith("-"):
                dest = spec.split(":", 1)[1]
                if not (dest.startswith("refs/pr/") or dest.startswith("refs/remotes/")):
                    raise Deny("review session: git fetch may only write refs/pr/* or refs/remotes/*")
        return
    if sub == "remote" and (not rest or rest[0] in ("-v", "--verbose", "show", "get-url")):
        return
    listing = any(a in ("-l", "--list", "-a", "-r", "-v", "-vv", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--show-current") for a in rest)
    if sub == "branch" and (listing or all(a.startswith("-") for a in rest)) \
            and not any(a in ("-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--force", "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description") for a in rest):
        return
    if sub == "tag" and (listing or all(a.startswith("-") for a in rest)) and not any(a in ("-d", "--delete", "-f", "--force", "-a", "-s", "-m", "-F") for a in rest):
        return
    if sub == "format-patch" and "--stdout" in rest and not any(a in ("-o", "--output-directory") or a.startswith("--output-directory=") for a in rest):
        return
    if sub == "config" and rest and rest[0] in ("--get", "--get-all", "--get-regexp", "-l", "--list"):
        return
    if sub == "worktree" and rest[:1] == ["list"]:
        return
    if sub == "stash" and rest[:1] in (["list"], ["show"]):
        return
    raise Deny(f"review session: git {sub} changes the tree or refs and is not allowed. A review reads with show, log, diff and fetch into refs/pr/*.")


def check_gh(argv):
    args = argv[1:]
    if not args:
        raise Deny("review session: bare gh is not allowed")
    if args[0] == "api":
        for opt in args[1:]:
            if opt.split("=")[0] in GH_API_WRITE:
                raise Deny(f"review session: gh api {opt} writes to GitHub or changes the host and is not allowed, GET requests only")
        return
    sub = args[1] if len(args) > 1 and not args[1].startswith("-") else None
    if (args[0], sub) in GH_READ or (args[0], None) in GH_READ:
        return
    what = " ".join(a for a in (args[0], sub) if a)
    raise Deny(f"review session: gh {what} is not a read-only query. Drafts go through /pr-post, nothing else is sent to GitHub from a review.")


def check_simple(argv, depth=0):
    if argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
        raise Deny(f"review session: environment assignments such as {argv[0].split('=')[0]}= are not allowed")
    if not argv:
        return
    name = os.path.basename(argv[0])
    if name == "git":
        check_git(argv)
    elif name == "gh":
        check_gh(argv)
    elif name == "xargs":
        inner = [a for a in argv[1:] if not a.startswith("-")]
        if depth > 2 or not inner:
            raise Deny("review session: xargs needs a command to run")
        check_simple(inner, depth + 1)
    elif name == "sed":
        if "--sandbox" not in argv:
            raise Deny("review session: sed is allowed only with --sandbox, which rejects the e, w and r commands")
        if "-i" in argv or any(a.startswith("--in-place") or (a.startswith("-") and not a.startswith("--") and "i" in a[1:]) for a in argv):
            raise Deny("review session: sed -i writes files and is not allowed")
    elif name in ("awk", "gawk"):
        if "--sandbox" not in argv:
            raise Deny("review session: awk is allowed only with --sandbox, which rejects system() and redirections")
    elif name in ("grep", "rg", "egrep", "fgrep"):
        if any(a.startswith("--pre") for a in argv):
            raise Deny("review session: grep/rg --pre runs a program and is not allowed")
    elif name == "find":
        if any(a in ("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls", "-fprint0") for a in argv):
            raise Deny("review session: find -exec and -delete are not allowed")
    elif name == "sort":
        if any(a in ("-o", "--output") or a.startswith("--output=") for a in argv):
            raise Deny("review session: sort -o writes files and is not allowed")
    elif name in ("python3", "python"):
        rest = argv[1:]
        while rest and rest[0].startswith("-") and not rest[0].startswith(("-c", "-m")):
            rest = rest[1:]
        if not rest or norm(rest[0]) != POST_SCRIPT:
            raise Deny(f"review session: python is allowed only as {POST_SCRIPT}, the pr-post script")
    elif name == "perl" or name == "checkpatch.pl":
        script = argv[1] if name == "perl" and len(argv) > 1 else argv[0]
        if os.path.basename(script) != "checkpatch.pl":
            raise Deny("review session: perl is allowed only for scripts/checkpatch.pl")
    elif name not in READ_ONLY:
        raise Deny(f"review session: '{name}' is not on the read-only review allowlist. Builds, flashing, package managers, network tools, shells and interpreters are off here. Give the user the exact command instead.")


def check_bash(tool_input):
    if tool_input.get("dangerouslyDisableSandbox"):
        raise Deny("review session: the sandbox stays on")
    command = tool_input.get("command") or ""
    for argv in split_commands(lex(command)):
        check_secret_paths(argv)
        check_simple(argv)


def check_fetch(tool_input):
    url = tool_input.get("url") or ""
    host = re.sub(r"^[a-z]+://", "", url).split("/")[0].split("@")[-1].split(":")[0].lower()
    if host not in ALLOWED_HOSTS:
        raise Deny(f"review session: fetching {host or url} is not allowed, only GitHub and the Zephyr docs")


def check(payload):
    tool = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if tool == "Bash":
        check_bash(tool_input)
    elif tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        check_write(tool_input.get("file_path") or tool_input.get("notebook_path"))
    elif tool == "WebFetch":
        check_fetch(tool_input)
    elif tool.startswith("mcp__claude_ai_"):
        raise Deny("review session: mail, drive, calendar and docs connectors are not available here")


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }))


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(payload, dict) or not is_review_session(payload):
        return
    try:
        check(payload)
    except Deny as err:
        deny(str(err))
    except Exception as err:
        deny(f"review session: guard could not evaluate the call ({err.__class__.__name__}), refusing")


if __name__ == "__main__":
    main()
    sys.exit(0)
