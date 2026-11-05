// The team's state in git. Everything about who is on the team (the agents, their teams and tasks, interviews,
// rules for calling each other, requests, mistakes, evaluations) lives in .agent-office, which git leaves out; so on
// another computer the profiles arrive (they are plain files) but the team doesn't. This keeps one file,
// freelance-team/state/team-state.json, up to date inside the repository, brings it back into .agent-office when
// the team is not there yet, and, when the person says so, starts each missing member again on a free desk with
// their profile (a new session: what an agent said before stays on the other computer).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SEATS, deskBuilt } from '../shared/layout.js';
import type { Floor } from './floor.js';
import { writeRoster } from './hiring-glue.js';

const FILES = ['team-teams.json', 'team-interviews.json', 'team-tasks.json', 'team-comms.json', 'team-requests.json', 'team-mistakes.json', 'team-evals.json'];
const SAVE_MS = 60_000;

export interface SnapshotMember {
  id: string;
  name: string;
  role?: string;
  desk: string;
  provider?: string;
  model?: string;
  effort?: string;
}
interface Snapshot {
  version: 1;
  savedAt: number;
  members: SnapshotMember[];
  files: Record<string, string>;
}

export const snapshotPath = (floorDir: string) => path.join(floorDir, 'freelance-team', 'state', 'team-state.json');

function readSnapshot(floorDir: string): Snapshot | undefined {
  try {
    const raw = JSON.parse(readFileSync(snapshotPath(floorDir), 'utf8'));
    return raw?.version === 1 && Array.isArray(raw.members) && raw.files && typeof raw.files === 'object' ? (raw as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Before the floor opens its stores: a floor with no team of its own (a fresh clone) takes the team files from the
 * snapshot, so its stores read them as if they had always been there. Returns whether it did.
 */
export function seedFromSnapshot(floorDir: string, dataDir: string): boolean {
  const snap = readSnapshot(floorDir);
  if (!snap || existsSync(path.join(dataDir, 'workers.json')) || FILES.some((f) => existsSync(path.join(dataDir, f)))) return false;
  mkdirSync(dataDir, { recursive: true });
  for (const [name, body] of Object.entries(snap.files)) if (FILES.includes(name)) writeFileSync(path.join(dataDir, name), body, 'utf8');
  return true;
}

/** Who the snapshot has that is not on the floor now, by name. */
export function missingMembers(floor: Floor): SnapshotMember[] {
  const snap = readSnapshot(floor.dir);
  if (!snap) return [];
  const here = new Set(floor.workers.list().filter((w) => w.kind === 'agent').map((w) => w.name));
  return snap.members.filter((m) => !here.has(m.name));
}

export class TeamSnapshot {
  private timer: NodeJS.Timeout;
  private last = '';

  /** `keepMissing`: this floor was seeded from the snapshot and not every member is back yet, so the ones still missing stay in it. */
  constructor(private floor: Floor, private dataDir: string, private keepMissing = false) {
    this.timer = setInterval(() => this.write(), SAVE_MS);
    this.timer.unref();
  }

  /** Writes the file when something changed. Skipped while a team is still to be brought back: it must not erase what the snapshot has. */
  write(force = false) {
    const f = this.floor;
    const members: SnapshotMember[] = f.workers.list().filter((w) => w.kind === 'agent').map((w) => ({ id: w.id, name: w.name, role: w.role, desk: w.deskId, provider: w.provider, model: w.model, effort: w.effort }));
    if (this.keepMissing) {
      const waiting = missingMembers(f);
      if (waiting.length) members.push(...waiting);
      else this.keepMissing = false;
    }
    if (!members.length && !force) return;
    const files: Record<string, string> = {};
    for (const name of FILES) {
      try {
        files[name] = readFileSync(path.join(this.dataDir, name), 'utf8');
      } catch {
        // Not written yet.
      }
    }
    const body = JSON.stringify({ members, files });
    if (body === this.last && !force) return;
    this.last = body;
    try {
      const file = snapshotPath(f.dir);
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), members, files }, null, 1), 'utf8');
      renameSync(tmp, file);
    } catch {
      // The next tick tries again.
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

/** Every store that holds a worker's id learns its new one. */
function swapEverywhere(floor: Floor, from: string, to: string) {
  floor.teams.swap(from, to);
  floor.interviews.swap(from, to);
  floor.teamTasks.swap(from, to);
  floor.comms.swap(from, to);
  floor.requests.swap(from, to);
  floor.mistakes.swap(from, to);
  floor.evals.swap(from, to);
}

/** Starts again each member the snapshot has and the floor lacks: same desk if free, same engine, from their profile. */
export function restoreMembers(floor: Floor, by: string): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  const wing = floor.workers.wing();
  const free = () => SEATS.filter((d) => !d.station && !d.room && !d.beanbag && deskBuilt(d, wing) && !floor.workers.deskOccupied(d.id));
  for (const m of missingMembers(floor)) {
    const talk = floor.interviews.all().filter((i) => i.worker === m.id).pop();
    const desk = free().find((d) => d.id === m.desk) ?? free()[0];
    if (!desk) {
      failed.push(`${m.name}: میز خالی نیست`);
      continue;
    }
    const folder = talk ? `freelance-team/people/${talk.slug}` : undefined;
    const team = floor.teams.teamOf(m.id);
    const intro = [
      `تو «${m.name}» هستی؛ همان آدمی که قبلاً با سمت «${(m.role ?? '').split(':')[0]}» در این دفتر کار می‌کرد و حالا روی این دستگاه دوباره آمده‌ای. هیچ کاری نکن و مصاحبه‌ی تازه‌ای در کار نیست.`,
      team ? (floor.teams.isManager(m.id) ? `تو مدیر تیم «${team.name}» هستی.` : `تو عضو تیم «${team.name}» هستی.`) : '',
      `فایل‌های freelance-team/company.md (کسب‌وکار)، ${folder ? `${folder}/skill.md و memory.md (پروفایل خودت)` : 'پروفایل خودت'}، freelance-team/people/ROSTER.md (تیم) و freelance-team/mistakes.md (اشتباهات و درس‌ها) را یک بار بخوان و بعد منتظر کار بمان.`,
    ].filter(Boolean).join('\n\n');
    const provider = m.provider && ['claude', 'codex', 'opencode', 'grok', 'muse', 'dsh', 'pi', 'cursor', 'custom'].includes(m.provider) ? (m.provider as never) : undefined;
    const made = floor.workers.spawn(desk.id, by, intro, false, 'agent', provider, m.model, m.effort as never);
    if (typeof made === 'string') {
      failed.push(`${m.name}: ${made}`);
      continue;
    }
    floor.workers.describe(made.id, { name: m.name, role: m.role ?? '' });
    swapEverywhere(floor, m.id, made.id);
    restored.push(m.name);
  }
  if (restored.length) {
    writeRoster(floor);
    floor.snapshot.write(true);
  }
  return { restored, failed };
}

