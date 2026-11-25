/* Share of a fetch done per group, in whole percent. A group's fetch
 * runs in three phases: search, details, then threads and filter
 * events. A phase counts once its size is known, an empty phase as
 * done.
 */
export type Phase = 'search' | 'detail' | 'finish';
export type ProgressSink = (percent: Record<string, number>) => void;

/* Key of the built-in pull request groups; custom filters use their group id. */
export const PRS_KEY = 'prs';

export function queryKey(name: string): string {
  return `query:${name}`;
}

const WEIGHT: Record<Phase, number> = { search: 0.2, detail: 0.5, finish: 0.3 };

export class Progress {
  private readonly parts = new Map<string, Map<Phase, { total: number; done: number }>>();
  private readonly sink: ProgressSink | undefined;

  constructor(sink?: ProgressSink) {
    this.sink = sink;
  }

  plan(key: string, phase: Phase, total: number): void {
    let phases = this.parts.get(key);
    if (!phases) {
      phases = new Map();
      this.parts.set(key, phases);
    }
    phases.set(phase, { total, done: 0 });
    this.emit();
  }

  tick(key: string, phase: Phase, n = 1): void {
    const p = this.parts.get(key)?.get(phase);
    if (p && n > 0) {
      p.done = Math.min(p.total, p.done + n);
      this.emit();
    }
  }

  percent(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, phases] of this.parts) {
      let share = 0;
      for (const [phase, p] of phases) {
        share += WEIGHT[phase] * (p.total === 0 ? 1 : p.done / p.total);
      }
      out[key] = Math.floor(share * 100);
    }
    return out;
  }

  private emit(): void {
    this.sink?.(this.percent());
  }
}
