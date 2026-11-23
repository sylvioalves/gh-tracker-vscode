import type { PullRequest } from './github.ts';

/* Query of vscode://anthropic.claude-code/open: a prompt left in the
 * input box for the user to send, and/or a session to resume.
 */
export function claudeOpenQuery(opts: { prompt?: string; session?: string }): string {
  const params = new URLSearchParams();
  if (opts.prompt) {
    params.set('prompt', opts.prompt);
  }
  if (opts.session) {
    params.set('session', opts.session);
  }
  return params.toString();
}

export function reviewPrompt(pr: PullRequest): string {
  return `/pr-rev ${pr.url}`;
}

export function postPrompt(pr: PullRequest): string {
  return `/pr-post ${pr.url}`;
}

export function issuePrompt(url: string): string {
  return `Analyze issue ${url}: reproduce the root cause in the tree and propose a fix plan.`;
}

/* 'PR #N ("title")', with the repository named when it is not zephyr. */
export function prReference(pr: PullRequest): string {
  const name = pr.repo.split('/')[1] ?? pr.repo;
  return `${name === 'zephyr' ? '' : `${name} `}PR #${pr.number} ("${pr.title}")`;
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/* The Claude CLI line a terminal runs: a settings profile when the
 * review one is configured, a session to resume, and the prompt.
 */
export function claudeCommand(prompt: string | undefined, opts: { settings?: string | undefined; resume?: string | undefined } = {}): string {
  const parts = ['claude'];
  if (opts.settings) {
    parts.push('--settings', shellQuote(opts.settings));
  }
  if (opts.resume) {
    parts.push('--resume', opts.resume);
  }
  if (prompt) {
    parts.push(shellQuote(prompt));
  }
  return parts.join(' ');
}

export function isUnder(dir: string, roots: string[]): boolean {
  const d = dir.replace(/\/+$/, '');
  return roots.some((r) => {
    const root = r.replace(/\/+$/, '');
    return d === root || d.startsWith(`${root}/`);
  });
}
