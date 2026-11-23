import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

function ghToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => {
      const token = String(stdout ?? '').trim();
      resolve(err || !token ? null : token);
    });
  });
}

/* The gh CLI token first, since the review skills use the same one,
 * then a VS Code GitHub session.
 */
export async function getToken(interactive: boolean): Promise<string | null> {
  const gh = await ghToken();
  if (gh) {
    return gh;
  }
  const session = await vscode.authentication.getSession('github', ['repo'],
    interactive ? { createIfNone: true } : { silent: true });
  return session?.accessToken ?? null;
}
