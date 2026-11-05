// Watches freelance-team/people for a member's skill.md being changed by anyone but the office itself (the person at
// the member window, an interview), and says so: the member's manager is told, and the change is logged. The profile
// gate (profile-gate.ts) asks the person first; this is what is left when a change slipped by it, or was allowed.
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/** Files the office wrote itself a moment ago (slug/name): not reported as someone else's change. */
const own = new Map<string, number>();
const OWN_MS = 8_000;

export function noteOwnWrite(slug: string, name: string) {
  own.set(`${slug}/${name}`, Date.now());
}

export class ProfileWatch {
  private seen = new Map<string, string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | undefined;

  constructor(private dir: string, private onChange: (slug: string, before: number, after: number) => void) {
    if (!existsSync(dir)) return;
    for (const slug of this.slugs()) this.seen.set(slug, this.read(slug));
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, file) => {
        const m = file && /^([^\\/]+)[\\/]skill\.md$/.exec(file.toString());
        if (m) this.later(m[1]);
      });
      this.watcher.on('error', () => this.watcher?.close());
      this.watcher.unref();
    } catch {
      // A platform without recursive watching: changes go unreported, nothing else.
    }
  }

  private slugs(): string[] {
    try {
      return readdirSync(this.dir).filter((s) => statSync(path.join(this.dir, s)).isDirectory());
    } catch {
      return [];
    }
  }

  private read(slug: string): string {
    try {
      return readFileSync(path.join(this.dir, slug, 'skill.md'), 'utf8');
    } catch {
      return '';
    }
  }

  private later(slug: string) {
    clearTimeout(this.timers.get(slug));
    const t = setTimeout(() => {
      this.timers.delete(slug);
      const now = this.read(slug);
      const before = this.seen.get(slug);
      this.seen.set(slug, now);
      if (before === undefined || before === now || !now) return;
      if (Date.now() - (own.get(`${slug}/skill.md`) ?? 0) < OWN_MS) return;
      this.onChange(slug, before.length, now.length);
    }, 4_000);
    t.unref();
    this.timers.set(slug, t);
  }

  close() {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
