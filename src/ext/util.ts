import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { transcriptPath, type Session } from '../core/sessions.ts';

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function sessionExpired(s: Session): boolean {
  return !existsSync(transcriptPath(claudeDir(), s.cwd, s.id));
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
