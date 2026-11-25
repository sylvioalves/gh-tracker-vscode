import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* One VS Code window polls GitHub. The lease file names it. Every
 * window renews or contests the lease on each tick: a lease is free
 * when it is missing, older than staleMs, or its process is gone.
 */
export interface LeaseState {
  id: string;
  pid: number;
  at: number;
}

export interface LeaseOptions {
  staleMs: number;
  pid?: number;
  now?: () => number;
  alive?: (pid: number) => boolean;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Lease {
  readonly id = randomUUID();
  private readonly file: string;
  private readonly opts: Required<LeaseOptions>;
  held = false;

  constructor(dir: string, opts: LeaseOptions) {
    this.file = join(dir, 'poll.lease');
    this.opts = { pid: process.pid, now: Date.now, alive: processAlive, ...opts };
    mkdirSync(dir, { recursive: true });
  }

  private read(): LeaseState | null {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8'));
      return typeof s?.id === 'string' && typeof s.pid === 'number' && typeof s.at === 'number' ? s : null;
    } catch {
      return null;
    }
  }

  private free(s: LeaseState | null): boolean {
    return s === null || s.id === this.id || this.opts.now() - s.at > this.opts.staleMs || !this.opts.alive(s.pid);
  }

  /* Takes or renews the lease when free. Returns whether this window
   * holds it afterwards.
   */
  tick(): boolean {
    if (this.free(this.read())) {
      const tmp = `${this.file}.${this.id}`;
      writeFileSync(tmp, JSON.stringify({ id: this.id, pid: this.opts.pid, at: this.opts.now() }));
      renameSync(tmp, this.file);
    }
    this.held = this.read()?.id === this.id;
    return this.held;
  }

  release(): void {
    if (this.read()?.id === this.id) {
      try {
        unlinkSync(this.file);
      } catch {
        /* already gone */
      }
    }
    this.held = false;
  }
}
