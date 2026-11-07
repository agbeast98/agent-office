// The projects a floor's team works on (the clients' sites and apps), and which of the system's folders each
// agent may use. A project has folders (say `front` and `back`) on this computer; the office tells every task
// and message which project it is about, gives each agent only the folders it was granted (--add-dir, and the
// PreToolUse check in folder-gate.ts), and asks the person before an agent goes outside them. The paths stay in
// .agent-office/projects.json (they differ from computer to computer); what is worth keeping in git, a project's
// description without its paths, is written to freelance-team/projects/<id>.md.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ProjectKind = 'existing' | 'new';
/** intake: being looked at before anything is built; ready: the person said it can be worked on. */
export type ProjectStatus = 'intake' | 'ready' | 'active' | 'paused' | 'done';
export type GrantMode = 'read' | 'write';

export interface ProjectFolder {
  name: string;
  path: string;
}

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  status: ProjectStatus;
  /** Languages and frameworks, in a line. */
  stack: string;
  /** How to run it, and how to test it. */
  run: string;
  test: string;
  /** What the person knows of it: the client, what is wanted, what to avoid. */
  notes: string;
  folders: ProjectFolder[];
  createdAt: number;
  updatedAt: number;
}

export interface Grant {
  project: string;
  folder: string;
  mode: GrantMode;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const KINDS: readonly ProjectKind[] = ['existing', 'new'];
const STATUSES: readonly ProjectStatus[] = ['intake', 'ready', 'active', 'paused', 'done'];
export const MAX_PROJECTS = 30;
const MAX_FOLDERS = 8;
const fail = (error: string) => ({ ok: false as const, error });
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether `target` is `root` or inside it. */
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Folders no agent is ever given: the whole disk, the home folder, keys and the like, and the office's own data. */
export function forbiddenFolder(folder: string, home = homedir()): string | undefined {
  const p = real(folder);
  if (path.parse(p).root === p) return 'ریشه‌ی درایو را نمی‌شود داد؛ پوشه‌ی خود پروژه را بدهید';
  if (same(p, real(home))) return 'پوشه‌ی کاربر را نمی‌شود داد؛ پوشه‌ی خود پروژه را بدهید';
  const parts = p.split(path.sep).map((x) => x.toLowerCase());
  const bad = ['.ssh', '.gnupg', '.aws', '.agent-office', '.claude', '.codex', '.config'].find((x) => parts.includes(x)) ?? (parts.includes('appdata') && parts.includes('roaming') ? 'AppData\Roaming' : undefined);
  if (bad) return `پوشه‌های ${bad} (کلید، تنظیمات و داده‌ی دفتر) داده نمی‌شوند`;
  return undefined;
}

export class Projects {
  private list_: Project[] = [];
  private grants: Record<string, Grant[]> = {};
  private next = 1;
  private file: string;

  /** `notesDir` is freelance-team/projects in the floor's repository. */
  constructor(dataDir: string, private notesDir?: string) {
    this.file = path.join(dataDir, 'projects.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { next?: number; projects?: Project[]; grants?: Record<string, Grant[]> };
      if (Array.isArray(s.projects)) this.list_ = s.projects.filter((p) => !!p && typeof p.id === 'string' && Array.isArray(p.folders));
      if (s.grants && typeof s.grants === 'object') this.grants = s.grants;
      this.next = Math.max(Number(s.next) || 1, ...this.list_.map((p) => Number(p.id.replace(/\D/g, '')) + 1));
    } catch {
      // A file that can't be read is started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ next: this.next, projects: this.list_, grants: this.grants }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Still held in memory until the next save works.
    }
  }

  list(): Project[] {
    return this.list_;
  }

  get(id: string): Project | undefined {
    return this.list_.find((p) => p.id === id);
  }

  /** A project by its id or its name. */
  find(key: string): Project | undefined {
    const k = key.trim();
    return this.get(k) ?? this.list_.find((p) => p.name === k) ?? this.list_.find((p) => p.name.toLowerCase() === k.toLowerCase());
  }

  /** Every folder of every project, with its project. */
  folders(): { project: Project; folder: ProjectFolder }[] {
    return this.list_.flatMap((project) => project.folders.map((folder) => ({ project, folder })));
  }

  private checkFolders(raw: unknown): Result<{ folders: ProjectFolder[] }> {
    if (!Array.isArray(raw)) return fail('پوشه‌ها درست نیست');
    if (raw.length > MAX_FOLDERS) return fail(`حداکثر ${MAX_FOLDERS} پوشه برای هر پروژه`);
    const out: ProjectFolder[] = [];
    for (const f of raw) {
      const name = text((f as ProjectFolder)?.name, 30).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
      const where = text((f as ProjectFolder)?.path, 500);
      if (!name || !where) return fail('هر پوشه نام (مثل front) و مسیر لازم دارد');
      if (!path.isAbsolute(where)) return fail(`مسیر «${name}» کامل نیست (مثلاً D:\\projects\\x\\front)`);
      let stat;
      try {
        stat = statSync(where);
      } catch {
        return fail(`پوشه‌ی «${name}» پیدا نشد: ${where}`);
      }
      if (!stat.isDirectory()) return fail(`«${name}» پوشه نیست`);
      const bad = forbiddenFolder(where);
      if (bad) return fail(`«${name}»: ${bad}`);
      if (out.some((o) => o.name === name)) return fail(`نام پوشه‌ی «${name}» دو بار آمده`);
      out.push({ name, path: real(where) });
    }
    return { ok: true, folders: out };
  }

  create(input: Record<string, unknown>): Result<{ project: Project }> {
    if (this.list_.length >= MAX_PROJECTS) return fail('تعداد پروژه‌ها به سقف رسیده');
    const name = text(input.name, 60);
    if (!name) return fail('پروژه نام لازم دارد');
    if (this.find(name)) return fail('پروژه‌ای با این نام هست');
    const kind = KINDS.find((k) => k === input.kind);
    if (!kind) return fail('نوع پروژه موجود یا تازه است');
    const folders = this.checkFolders(input.folders ?? []);
    if (!folders.ok) return folders;
    if (kind === 'existing' && !folders.folders.length) return fail('پروژه‌ی موجود حداقل یک پوشه لازم دارد');
    const now = Date.now();
    const project: Project = { id: `P${this.next++}`, name, kind, status: 'intake', stack: text(input.stack, 200), run: text(input.run, 300), test: text(input.test, 300), notes: text(input.notes, 3000), folders: folders.folders, createdAt: now, updatedAt: now };
    this.list_.push(project);
    this.save();
    this.writeNotes(project);
    return { ok: true, project };
  }

  update(id: string, input: Record<string, unknown>): Result<{ project: Project }> {
    const p = this.get(id);
    if (!p) return fail('چنین پروژه‌ای نیست');
    if (input.name !== undefined) {
      const name = text(input.name, 60);
      if (!name) return fail('پروژه نام لازم دارد');
      if (this.list_.some((x) => x !== p && x.name === name)) return fail('پروژه‌ای با این نام هست');
      p.name = name;
    }
    if (input.status !== undefined) {
      const status = STATUSES.find((s) => s === input.status);
      if (!status) return fail('وضعیت درست نیست');
      p.status = status;
    }
    for (const k of ['stack', 'run', 'test'] as const) if (input[k] !== undefined) p[k] = text(input[k], k === 'stack' ? 200 : 300);
    if (input.notes !== undefined) p.notes = text(input.notes, 3000);
    if (input.folders !== undefined) {
      const folders = this.checkFolders(input.folders);
      if (!folders.ok) return folders;
      p.folders = folders.folders;
      // A grant on a folder that is gone goes with it.
      for (const [w, gs] of Object.entries(this.grants)) this.grants[w] = gs.filter((g) => g.project !== p.id || p.folders.some((f) => f.name === g.folder));
    }
    p.updatedAt = Date.now();
    this.save();
    this.writeNotes(p);
    return { ok: true, project: p };
  }

  // ---- Which agent may use which folder ----

  grantsOf(worker: string): Grant[] {
    return this.grants[worker] ?? [];
  }

  allGrants(): Record<string, Grant[]> {
    return this.grants;
  }

  /** Gives, changes or takes back (`none`) one agent's access to one folder of a project. */
  setGrant(worker: string, projectId: string, folder: string, mode: GrantMode | 'none'): Result {
    const p = this.get(projectId);
    if (!p || !p.folders.some((f) => f.name === folder)) return fail('پروژه یا پوشه پیدا نشد');
    const rest = this.grantsOf(worker).filter((g) => !(g.project === projectId && g.folder === folder));
    this.grants[worker] = mode === 'none' ? rest : [...rest, { project: projectId, folder, mode }];
    if (!this.grants[worker].length) delete this.grants[worker];
    this.save();
    return { ok: true };
  }

  /** The same person on another engine, or sent home: the grants follow the new id, or go. */
  swap(from: string, to: string) {
    if (!this.grants[from]) return;
    this.grants[to] = this.grants[from];
    delete this.grants[from];
    this.save();
  }

  forget(worker: string) {
    if (this.grants[worker]) {
      delete this.grants[worker];
      this.save();
    }
  }

  /** The folders of the projects a worker was granted, for its command line. */
  dirsFor(worker: string, isManager = false): { read: string[]; write: string[] } {
    const read = new Set<string>();
    const write = new Set<string>();
    for (const { project, folder } of this.folders()) {
      const mode = this.modeFor(worker, project, folder, isManager);
      if (mode && existsSync(folder.path)) (mode === 'write' ? write : read).add(folder.path);
    }
    return { read: [...read], write: [...write] };
  }

  private modeFor(worker: string, project: Project, folder: ProjectFolder, isManager: boolean): GrantMode | undefined {
    const g = this.grantsOf(worker).find((x) => x.project === project.id && x.folder === folder.name);
    // A team's manager reads every project's folders, so it can look at the work it hands out.
    return g?.mode ?? (isManager ? 'read' : undefined);
  }

  /**
   * What `worker` may do at `target`: undefined when it is in none of the projects' folders (the checks leave it
   * alone), otherwise the project and folder it is in and the mode it was given there (none: not granted).
   */
  access(worker: string, target: string, isManager = false): { project: Project; folder: ProjectFolder; mode?: GrantMode } | undefined {
    const t = real(target);
    let best: { project: Project; folder: ProjectFolder } | undefined;
    for (const hit of this.folders()) {
      if (within(hit.folder.path, t) && (!best || hit.folder.path.length > best.folder.path.length)) best = hit;
    }
    return best && { ...best, mode: this.modeFor(worker, best.project, best.folder, isManager) };
  }

  // ---- In git ----

  /** freelance-team/projects/<id>.md: the description without the paths, so the other computers know the project. */
  private writeNotes(p: Project) {
    if (!this.notesDir) return;
    const lines: (string | false)[] = [
      `# ${p.name} (${p.id})`,
      '',
      `- نوع: ${p.kind === 'existing' ? 'پروژه‌ی موجود (بررسی قبلی)' : 'پروژه‌ی تازه (بررسی کامل)'}`,
      `- وضعیت: ${p.status}`,
      p.stack && `- فناوری: ${p.stack}`,
      p.run && `- اجرا: ${p.run}`,
      p.test && `- تست: ${p.test}`,
      p.folders.length > 0 && `- پوشه‌ها: ${p.folders.map((f) => f.name).join('، ')} (مسیرها در دفتر هر کامپیوتر جدا نگه داشته می‌شود)`,
      '',
      '## یادداشت',
      p.notes || '(هنوز چیزی نوشته نشده)',
      '',
    ].filter((l): l is string => l !== false);
    try {
      mkdirSync(this.notesDir, { recursive: true });
      writeFileSync(path.join(this.notesDir, `${p.id}.md`), `${lines.join('\n')}`, 'utf8');
    } catch {
      // The description is only a copy; the project itself is saved.
    }
  }
}
