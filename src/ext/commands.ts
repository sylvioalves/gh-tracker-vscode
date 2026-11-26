import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { claudeCommand, claudeOpenQuery, issuePrompt, isUnder, postPrompt, prReference, reviewPrompt } from '../core/claude.ts';
import { authorTrust } from '../core/github.ts';
import type { Session } from '../core/sessions.ts';
import type { IssueRow, Row, ViewRow } from '../core/view.ts';
import { expandHome, type Store } from './store.ts';
import { sessionExpired } from './util.ts';

/* Terminal sessions carry the review profile: the settings file from
 * ghtracker.reviewSettings, the marker the review-guard hook reads,
 * and an https rewrite so git fetch works without ssh keys.
 */
const REVIEW_ENV = {
  CLAUDE_REVIEW_SESSION: '1',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
};

function reviewSettings(): string | undefined | null {
  const raw = vscode.workspace.getConfiguration('ghtracker').get<string>('reviewSettings', '').trim();
  if (!raw) {
    return undefined;
  }
  const path = expandHome(raw);
  if (!existsSync(path)) {
    void vscode.window.showErrorMessage(`GH Tracker: review profile ${raw} not found. Create it or clear ghtracker.reviewSettings.`);
    return null;
  }
  return path;
}

/* What a command acts on: sent by the panel or by its context menu. */
export interface Target {
  prKey?: string;
  sessionId?: string;
}

function openClaude(opts: { prompt?: string; session?: string }): Thenable<boolean> {
  const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'anthropic.claude-code', path: '/open', query: claudeOpenQuery(opts) });
  return vscode.env.openExternal(uri);
}

const GHPR = 'GitHub.vscode-pull-request-github';

/* Opens the pull request page or its changed files in a VS Code tab
 * through the GitHub Pull Requests extension, without a checkout, or
 * in the browser when that extension is missing.
 */
const BROWSER_OPEN = 'workbench.action.browser.open';

/* Opens the pull request where the ghtracker.openPrIn setting says: VS
 * Code's integrated browser (the real github.com page), the GitHub Pull
 * Requests extension, or the system browser.
 */
async function openPr(row: Row): Promise<unknown> {
  const where = vscode.workspace.getConfiguration('ghtracker').get<string>('openPrIn', 'integratedBrowser');
  if (where === 'integratedBrowser' && (await vscode.commands.getCommands(true)).includes(BROWSER_OPEN)) {
    return vscode.commands.executeCommand(BROWSER_OPEN, row.pr.url);
  }
  if (where === 'externalBrowser') {
    return vscode.env.openExternal(vscode.Uri.parse(row.pr.url));
  }
  return openPrInEditor(row, '/open-pull-request-webview');
}

function openPrInEditor(row: Row, path: '/open-pull-request-webview' | '/open-pull-request-changes'): Thenable<boolean> {
  if (!vscode.extensions.getExtension(GHPR)) {
    return vscode.env.openExternal(vscode.Uri.parse(row.pr.url));
  }
  const query = new URLSearchParams({ uri: row.pr.url }).toString();
  return vscode.env.openExternal(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: GHPR, path, query }));
}

/* A new review: a Claude tab with the prompt left for the user to send,
 * or the Claude CLI in a terminal, which sends it at once.
 */
async function startReview(item: ViewRow, prompt: string): Promise<void> {
  const mode = vscode.workspace.getConfiguration('ghtracker').get<string>('reviewLaunch', 'tab');
  if (mode === 'tab') {
    void openClaude({ prompt });
    return;
  }
  const { number, author, association } = item.kind === 'pr'
    ? { number: item.pr.number, author: item.pr.author, association: item.pr.authorAssociation }
    : { number: item.issue.number, author: item.issue.author, association: item.issue.authorAssociation };
  const trust = authorTrust(association);
  if (trust === 'new' || trust === 'unknown') {
    const who = trust === 'new' ? `${author} is a first-time contributor` : `${author} has no known relation to the repository`;
    const pick = await vscode.window.showWarningMessage(
      `#${number}: ${who}. Its text and diff go straight into a Claude session. Start it now?`, { modal: true }, 'Start');
    if (pick !== 'Start') {
      return;
    }
  }
  const settings = reviewSettings();
  if (settings === null) {
    return;
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const name = `${prompt.split(' ')[0]} #${number}`;
  const term = vscode.window.createTerminal({ name, env: REVIEW_ENV, ...(cwd ? { cwd } : {}) });
  term.show();
  term.sendText(claudeCommand(prompt, { settings }));
}

function resume(session: Session, prompt?: string): void {
  if (sessionExpired(session)) {
    void vscode.window.showWarningMessage('GH Tracker: this Claude session has expired.');
    return;
  }
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (isUnder(session.cwd, roots)) {
    void openClaude(prompt ? { session: session.id, prompt } : { session: session.id });
    return;
  }
  const settings = reviewSettings();
  if (settings === null) {
    return;
  }
  const term = vscode.window.createTerminal({ name: `Claude ${session.id.slice(0, 8)}`, cwd: session.cwd, env: REVIEW_ENV });
  term.show();
  term.sendText(claudeCommand(prompt, { settings, resume: session.id }));
}

const SESSION_COMMANDS: [string, string][] = [
  ['ghtracker.fresh', '/fresh'],
  ['ghtracker.findings', '/findings'],
  ['ghtracker.cleanup', '/cleanup'],
];

function sessionOf(store: Store, target: Target | undefined): { row: Row; session: Session } | undefined {
  const found = target?.prKey ? store.rowByKey(target.prKey) : undefined;
  const row = found?.kind === 'pr' ? found : undefined;
  const session = target?.sessionId
    ? row?.sessions.find((s) => s.id === target.sessionId)
    : row?.sessions.find((s) => !sessionExpired(s));
  return row && session ? { row, session } : undefined;
}

const PR_REF_RE = /(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\/pull\/|#)(\d+)/;

export function registerCommands(context: vscode.ExtensionContext, store: Store): void {
  const withKind = <T extends ViewRow>(ok: (row: ViewRow) => row is T) => (fn: (row: T) => unknown) => (target?: Target) => {
    const row = target?.prKey ? store.rowByKey(target.prKey) : undefined;
    if (row && ok(row)) {
      void store.markSeen([row.key]);
      return fn(row);
    }
    return undefined;
  };
  const withItem = withKind((row): row is ViewRow => true);
  const withRow = withKind((row): row is Row => row.kind === 'pr');
  const withIssue = withKind((row): row is IssueRow => row.kind === 'issue');
  context.subscriptions.push(
    vscode.commands.registerCommand('ghtracker.review', withRow((row) => startReview(row, reviewPrompt(row.pr)))),
    vscode.commands.registerCommand('ghtracker.analyzeIssue', withIssue((row) => startReview(row, issuePrompt(row.issue.url)))),
    vscode.commands.registerCommand('ghtracker.postDraft', withRow((row) => startReview(row, postPrompt(row.pr)))),
    vscode.commands.registerCommand('ghtracker.openInEditor', withRow((row) => openPr(row))),
    vscode.commands.registerCommand('ghtracker.openInGitHubExtension', withRow((row) => openPrInEditor(row, '/open-pull-request-webview'))),
    vscode.commands.registerCommand('ghtracker.openChanges', withRow((row) => openPrInEditor(row, '/open-pull-request-changes'))),
    vscode.commands.registerCommand('ghtracker.openOnGitHub', withItem((row) => vscode.env.openExternal(vscode.Uri.parse(row.kind === 'pr' ? row.pr.url : row.issue.url)))),
    vscode.commands.registerCommand('ghtracker.copyRef', withRow(async (row) => {
      await vscode.env.clipboard.writeText(prReference(row.pr));
      vscode.window.setStatusBarMessage(`Copied ${prReference(row.pr)}`, 3000);
    })),
    vscode.commands.registerCommand('ghtracker.markRead', withItem(() => undefined)),
    vscode.commands.registerCommand('ghtracker.markChecked', withRow((row) => store.ack(row))),
    vscode.commands.registerCommand('ghtracker.uncheck', withRow((row) => store.unack(row.key))),
    vscode.commands.registerCommand('ghtracker.keep', withRow((row) => store.setKept(row.key, true))),
    vscode.commands.registerCommand('ghtracker.unkeep', withRow((row) => store.setKept(row.key, false))),
    vscode.commands.registerCommand('ghtracker.unpin', withRow((row) => store.unpin(row.key))),
    vscode.commands.registerCommand('ghtracker.openLedger', withRow((row) => {
      if (row.ledger) {
        return vscode.window.showTextDocument(vscode.Uri.file(row.ledger.file), { preview: true });
      }
      return undefined;
    })),
    vscode.commands.registerCommand('ghtracker.openSession', (target?: Target) => {
      const hit = sessionOf(store, target);
      if (hit) {
        void store.markSeen([hit.row.key]);
        resume(hit.session);
      }
    }),
    ...SESSION_COMMANDS.map(([id, prompt]) => vscode.commands.registerCommand(id, (target?: Target) => {
      const hit = sessionOf(store, target);
      if (!hit) {
        void vscode.window.showWarningMessage('GH Tracker: no live Claude session for this pull request. Start one with Review with Claude.');
        return;
      }
      void store.markSeen([hit.row.key]);
      resume(hit.session, prompt);
    })),
    vscode.commands.registerCommand('ghtracker.pin', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Pull request to track',
        placeHolder: 'https://github.com/owner/repo/pull/123 or owner/repo#123',
        validateInput: (v) => (PR_REF_RE.test(v.trim()) ? undefined : 'Expected a pull request URL or owner/repo#N'),
      });
      const m = text ? PR_REF_RE.exec(text.trim()) : null;
      if (m) {
        await store.pin({ repo: m[1]!, number: Number(m[2]) });
      }
    }),
  );
}
