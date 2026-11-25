import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromEditor, ToEditor } from '../core/filter-messages.ts';
import { customQueries, GithubError, repoLabels, searchPreview, type Gql, type RepoLabel, type SearchPreview } from '../core/github.ts';
import { getToken } from './auth.ts';
import { githubClient, settings } from './store.ts';
import { clock } from './util.ts';

const PREVIEW_TTL_MS = 60_000;

async function client(): Promise<Gql> {
  const token = await getToken(false);
  if (!token) {
    throw new Error('Not signed in to GitHub');
  }
  return githubClient(token, true);
}

function errorText(err: unknown): string {
  if (err instanceof GithubError && err.resetAt) {
    return `GitHub rate limit reached, try again at ${clock(err.resetAt)}`;
  }
  return err instanceof GithubError && err.status === 401 ? 'GitHub rejected the token' : (err as Error).message;
}

async function writeQueries(queries: { name: string; query: string }[]): Promise<void> {
  await vscode.workspace.getConfiguration('ghtracker').update('queries', queries, vscode.ConfigurationTarget.Global);
}

export class FiltersEditor implements vscode.Disposable {
  static readonly viewType = 'ghtracker.filters';
  private static current: FiltersEditor | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly media: vscode.Uri;
  private readonly subs: vscode.Disposable[] = [];
  private readonly labels = new Map<string, Promise<RepoLabel[]>>();
  private readonly previews = new Map<string, { at: number; result: SearchPreview }>();
  private ready = false;
  private pending: ToEditor[] = [];

  static show(context: vscode.ExtensionContext, action?: ToEditor): void {
    const editor = FiltersEditor.current ?? new FiltersEditor(context);
    FiltersEditor.current = editor;
    editor.panel.reveal();
    if (action) {
      editor.post(action);
    }
  }

  private constructor(context: vscode.ExtensionContext) {
    this.media = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(FiltersEditor.viewType, 'GH Tracker: Filters', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.media],
    });
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg: FromEditor) => void this.receive(msg), undefined, this.subs);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.subs);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ghtracker.queries') || e.affectsConfiguration('ghtracker.repos')) {
        this.sendSettings();
      }
    }, undefined, this.subs);
  }

  dispose(): void {
    if (FiltersEditor.current === this) {
      FiltersEditor.current = undefined;
    }
    for (const s of this.subs) {
      s.dispose();
    }
    this.subs.length = 0;
  }

  private post(msg: ToEditor): void {
    if (this.ready) {
      void this.panel.webview.postMessage(msg);
    } else {
      this.pending.push(msg);
    }
  }

  private sendSettings(): void {
    const s = settings();
    this.post({ type: 'settings', filters: s.queries, repos: s.repos });
  }

  private async receive(msg: FromEditor): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        this.sendSettings();
        const queued = this.pending;
        this.pending = [];
        for (const m of queued) {
          this.post(m);
        }
        break;
      }
      case 'save': {
        const clean = customQueries(msg.filters);
        if (clean.length !== msg.filters.length) {
          this.post({ type: 'saveFailed', message: 'Every filter needs a unique name and a query' });
          break;
        }
        try {
          await writeQueries(clean);
          this.post({ type: 'saved' });
        } catch (err) {
          this.post({ type: 'saveFailed', message: (err as Error).message });
        }
        break;
      }
      case 'labels': {
        let labels = this.labels.get(msg.repo);
        if (!labels) {
          labels = client().then((gql) => repoLabels(gql, msg.repo));
          this.labels.set(msg.repo, labels);
        }
        try {
          this.post({ type: 'labels', repo: msg.repo, labels: await labels });
        } catch (err) {
          this.labels.delete(msg.repo);
          this.post({ type: 'labels', repo: msg.repo, labels: [], error: errorText(err) });
        }
        break;
      }
      case 'preview': {
        try {
          const hit = this.previews.get(msg.query);
          const result = hit && Date.now() - hit.at < PREVIEW_TTL_MS ? hit.result : await searchPreview(await client(), msg.query);
          if (hit?.result !== result) {
            this.previews.set(msg.query, { at: Date.now(), result });
          }
          this.post({ type: 'preview', seq: msg.seq, result });
        } catch (err) {
          this.post({ type: 'previewError', seq: msg.seq, message: errorText(err) });
        }
        break;
      }
      case 'open': {
        if (msg.url.startsWith('https://github.com/')) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (file: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(this.media, file));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicon.css')}">
<link rel="stylesheet" href="${uri('filters.css')}">
<title>GH Tracker: Filters</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('filters.js')}"></script>
</body>
</html>`;
  }
}

/* The argument a webview/context menu passes from data-vscode-context. */
interface FilterTarget {
  filterName?: string;
}

export function registerFilterCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ghtracker.manageFilters', () => FiltersEditor.show(context)),
    vscode.commands.registerCommand('ghtracker.addFilter', () => FiltersEditor.show(context, { type: 'create' })),
    vscode.commands.registerCommand('ghtracker.editFilter', (target?: FilterTarget) => {
      FiltersEditor.show(context, target?.filterName ? { type: 'select', name: target.filterName } : undefined);
    }),
    vscode.commands.registerCommand('ghtracker.removeFilter', async (target?: FilterTarget) => {
      const name = target?.filterName;
      if (!name) {
        return;
      }
      const pick = await vscode.window.showWarningMessage(`Remove the filter "${name}"?`, { modal: true }, 'Remove');
      if (pick === 'Remove') {
        await writeQueries(settings().queries.filter((q) => q.name !== name));
      }
    }),
  );
}
