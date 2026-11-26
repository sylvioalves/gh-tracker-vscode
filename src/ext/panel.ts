import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { overallProgress, panelData } from '../core/panel-data.ts';
import { ago } from '../core/view.ts';
import type { Target } from './commands.ts';
import { lastRate, type Store } from './store.ts';
import { clock, sessionExpired } from './util.ts';

const ALLOWED = /^ghtracker\.[A-Za-z]+$/;

export class PrPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'ghtracker.prs';
  private view: vscode.WebviewView | undefined;
  private readonly store: Store;
  private readonly media: vscode.Uri;
  private readonly subs: vscode.Disposable[] = [];
  private pendingSearch = false;

  constructor(context: vscode.ExtensionContext, store: Store) {
    this.store = store;
    this.media = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    this.subs.push(store.onDidChange(() => this.update()));
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
  }

  collapseAll(): void {
    void this.view?.webview.postMessage({ type: 'collapseAll' });
  }

  async search(): Promise<void> {
    const ready = this.view !== undefined;
    this.pendingSearch = !ready;
    if (!this.view?.visible) {
      await vscode.commands.executeCommand(`${PrPanel.id}.focus`);
    }
    if (ready) {
      void this.view?.webview.postMessage({ type: 'search' });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; command?: string; ids?: unknown } & Target) => {
      if (msg.type === 'ready') {
        this.update();
        if (this.pendingSearch) {
          this.pendingSearch = false;
          void view.webview.postMessage({ type: 'search' });
        }
      } else if (msg.type === 'command' && msg.command && ALLOWED.test(msg.command)) {
        void vscode.commands.executeCommand(msg.command, { prKey: msg.prKey, sessionId: msg.sessionId });
      } else if (msg.type === 'order' && Array.isArray(msg.ids)) {
        void this.store.setGroupOrder(msg.ids.slice(0, 100));
      }
    }, undefined, this.subs);
    view.onDidChangeVisibility(() => this.update(), undefined, this.subs);
    view.onDidDispose(() => {
      this.view = undefined;
    }, undefined, this.subs);
  }

  private update(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const store = this.store;
    const unseen = store.myTurn.filter((r) => r.unseen).length;
    view.badge = unseen > 0 ? { value: unseen, tooltip: `${unseen} pull requests changed on your turn` } : undefined;
    const st = store.status;
    const overall = overallProgress(store.progress);
    const rate = lastRate();
    const budget = rate ? `, API ${Math.floor((rate.remaining / rate.limit) * 100)}% left` : '';
    view.description = st.kind === 'loading' ? `refreshing ${overall ?? 0}%`
      : st.kind === 'limited' ? `rate limited until ${clock(st.until)}`
      : (store.fetchedAt ? `updated ${ago(store.fetchedAt)}${budget}` : '');
    if (!view.visible) {
      return;
    }
    const groups = panelData(store.groups, { expired: sessionExpired, pinned: (k) => store.isPinned(k), progress: store.progress });
    const status = st.kind === 'error' ? { kind: 'error', message: st.message }
      : st.kind === 'limited' ? { kind: 'limited', message: `GitHub rate limit reached. Next refresh at ${clock(st.until)}.` }
      : st.kind === 'loading' ? { kind: 'loading', message: `Loading pull requests... ${overall ?? 0}%` }
      : { kind: st.kind };
    void view.webview.postMessage({ type: 'data', groups, status });
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
<link rel="stylesheet" href="${uri('panel.css')}">
</head>
<body>
<div id="search" class="search" hidden>
<i class="codicon codicon-search"></i>
<input id="query" type="text" placeholder="Search number, author, title, label" aria-label="Search the list" spellcheck="false">
<button id="clear" class="act" title="Clear and Close (Escape)" aria-label="Clear and close search"><i class="codicon codicon-close"></i></button>
</div>
<div id="root" role="tree" aria-label="Pull requests"></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body>
</html>`;
  }
}
