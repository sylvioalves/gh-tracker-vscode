import * as vscode from 'vscode';
import { registerCommands } from './commands.ts';
import { registerFilterCommands } from './filters.ts';
import { PrPanel } from './panel.ts';
import { settings, Store } from './store.ts';

function watch(context: vscode.ExtensionContext, file: string, onChange: () => void): void {
  const uri = vscode.Uri.file(file);
  const dir = vscode.Uri.joinPath(uri, '..');
  const name = uri.path.split('/').pop()!;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);
}

/* Carries settings and the cached snapshot over from the former
 * extension id, prdeck.
 */
async function migrate(context: vscode.ExtensionContext): Promise<void> {
  const props: Record<string, unknown> = context.extension.packageJSON?.contributes?.configuration?.properties ?? {};
  const before = vscode.workspace.getConfiguration('prdeck');
  const now = vscode.workspace.getConfiguration('ghtracker');
  for (const key of Object.keys(props).map((k) => k.replace(/^ghtracker\./, ''))) {
    const value = before.inspect(key)?.globalValue;
    if (value !== undefined && now.inspect(key)?.globalValue === undefined) {
      await now.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }
  const snapshot = vscode.Uri.joinPath(context.globalStorageUri, 'snapshot.json');
  try {
    await vscode.workspace.fs.stat(snapshot);
  } catch {
    try {
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      await vscode.workspace.fs.copy(vscode.Uri.joinPath(context.globalStorageUri, '..', 'sylvioalves.prdeck', 'snapshot.json'), snapshot);
    } catch {
      /* no snapshot to carry over */
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await migrate(context);
  } catch (err) {
    console.error('GH Tracker: settings migration failed', err);
  }
  const store = new Store(context);
  const panel = new PrPanel(context, store);
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'ghtracker.prs.focus';

  const render = (): void => {
    const mine = store.myTurn;
    const unseen = mine.filter((r) => r.unseen).length;
    bar.text = `$(git-pull-request) ${mine.length}${unseen > 0 ? ` $(circle-filled) ${unseen}` : ''}`;
    bar.tooltip = store.groups.map((g) => `${g.label}: ${g.rows.length}`).join('\n') || 'GH Tracker';
    bar.show();
  };

  let reload: NodeJS.Timeout | undefined;
  const reloadLocal = (): void => {
    clearTimeout(reload);
    reload = setTimeout(() => store.reloadLocal(), 500);
  };
  const s = settings();
  watch(context, `${s.ledgerDir}/*.md`, reloadLocal);
  watch(context, s.sessionIndex, reloadLocal);

  context.subscriptions.push(
    store,
    panel,
    bar,
    vscode.window.registerWebviewViewProvider(PrPanel.id, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    store.onDidChange(render),
    vscode.commands.registerCommand('ghtracker.refresh', () => store.refresh(false)),
    vscode.commands.registerCommand('ghtracker.signIn', () => store.refresh(true)),
    vscode.commands.registerCommand('ghtracker.collapseAll', () => panel.collapseAll()),
    vscode.commands.registerCommand('ghtracker.markAllSeen', () => store.markSeen(store.groups.flatMap((g) => g.rows).map((r) => r.key))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('ghtracker')) {
        return;
      }
      store.reloadLocal();
      if (['repos', 'watchedLabels', 'pollMinutes'].some((k) => e.affectsConfiguration(`ghtracker.${k}`))) {
        void store.refresh(false);
      } else if (e.affectsConfiguration('ghtracker.queries')) {
        void store.refreshQueries();
      }
    }),
  );
  registerCommands(context, store);
  registerFilterCommands(context);
  render();
  void store.start();
}

export function deactivate(): void {}
