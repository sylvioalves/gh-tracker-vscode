# GH Tracker

A VS Code side panel that tracks GitHub pull requests and issues and
launches Claude Code reviews from them.

## Features

- Pull requests grouped by what they need from you: pending reviews,
  re-check after a push or reply, your own PRs, review requests, and
  PRs waiting on the author or on reviewers.
- Unread rows in bold, sorted by last update. A click marks a row read.
- Custom filters: any GitHub search (issues, pull requests or both)
  becomes its own group. Edit them in the "Manage Filters" tab, with
  repository label suggestions and a live result preview.
- Claude Code integration: "Review with Claude" opens a Claude tab with
  `/pr-rev <url>`, and "Analyze Issue with Claude" opens one with an
  analysis prompt. Review sessions and review ledgers are listed under
  each pull request, with buttons for `/fresh`, `/findings` and
  `/cleanup`.
- Pull requests open in the VS Code integrated browser, the GitHub Pull
  Requests extension or an external browser (`ghtracker.openPrIn`).

## Requirements

- VS Code 1.100 or later.
- A GitHub token: the `gh` CLI (`gh auth login`) is used first, then the
  VS Code GitHub account.
- Node.js 22 or later to build. The tests run TypeScript directly and
  need Node.js 23.6 or later.
- Claude Code for VS Code for the review actions.

## Build and install

    npm ci
    npm run package
    VSCODE_PROFILE=<profile> npm run install-ext

`install-ext` installs into the default VS Code profile, or into the profile
named by `VSCODE_PROFILE` when it is set. Check which profile a window uses
under File > Preferences > Profiles: an extension installed into another
profile is silently absent.
Run `npm test` for the unit tests and `npm run check` for the type check.

## Session tracking hook

`hooks/pr-session-index.py` is a Claude Code `UserPromptSubmit` hook. It
records which Claude session ran `/pr-rev`, `/fresh`, `/findings` or
`/pr-post` on which pull request, in
`~/.claude/reviews/sessions.jsonl`. Install the script with
`npm run install-hook` (which also installs the review guard below), then add it to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "python3 ~/.claude/hooks/pr-session-index.py" }
        ]
      }
    ]
  }
}
```

## Settings

All settings live under `ghtracker.*`: tracked repositories, watched
labels, custom filters, poll interval, ledger and session index paths,
notifications, how reviews are launched and where pull requests open.

## License

MIT

## Review guard hook

`hooks/review-guard.py` is a Claude Code `PreToolUse` hook that keeps
review sessions read-only. A session counts as a review session once
`/pr-rev`, `/fresh`, `/findings` or `/pr-post` ran in it (the session
index above) or when `CLAUDE_REVIEW_SESSION=1` is in the environment,
which the extension sets on the terminals it opens. In such a session
the hook allows read-only shell commands, read-only `git` and `gh`
subcommands, the pr-post script and file writes under
`~/.claude/reviews`, and denies everything else with a reason. The
pull request text, diff and comments are untrusted input to the
model, and this is what stops an instruction hidden in them from
running a command, posting to GitHub or changing files.

Install it with `npm run install-hook` and register it in
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [
          { "type": "command", "command": "python3 ~/.claude/hooks/review-guard.py", "timeout": 10, "onFailure": "block" }
        ]
      }
    ]
  }
}
```

## Review profile for terminals

With `ghtracker.reviewLaunch` set to `terminal`, the extension starts
`claude --settings <ghtracker.reviewSettings>` (default
`~/.claude/profiles/review.json`). That profile turns on the Claude
Code sandbox with network access limited to GitHub, masks the `gh`
token so sandboxed commands never see it, blocks reads of credential
files, and rewrites `git@github.com:` remotes to https so `git fetch`
works without ssh keys. A pull request by a first-time contributor,
or by an author whose relation to the repository is unknown, asks for
confirmation before the terminal session starts.

## Releasing

A release is a tag. Bump `version` in `package.json`, commit, then:

    git tag -a v0.2.0 -m "GH Tracker 0.2.0"
    git push origin main v0.2.0

The `release` workflow checks that the tag matches `package.json`, runs
the type check and the tests, packages the vsix, attaches it to a GitHub
release, and publishes it to the Visual Studio Marketplace when the
`VSCE_PAT` repository secret is set (and to Open VSX when `OVSX_PAT` is
set). Once a version is on the marketplace, VS Code updates the installed
extension by itself, like any other extension. Without the secret, install
the vsix from the release page with `code --install-extension`.
