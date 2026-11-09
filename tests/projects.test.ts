import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { folderGate } from '../src/server/folder-gate.js';
import { forbiddenFolder, Projects } from '../src/server/projects.js';
import { TeamRequests } from '../src/server/team-ledgers.js';
import { TeamTasks } from '../src/server/team-tasks.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function fresh() {
  const root = mkdtempSync(path.join(tmpdir(), 'projects-'));
  const front = path.join(root, 'shop', 'front');
  const back = path.join(root, 'shop', 'back');
  const other = path.join(root, 'blog', 'site');
  for (const d of [front, back, other, path.join(root, 'data')]) mkdirSync(d, { recursive: true });
  const notes = path.join(root, 'notes');
  const projects = new Projects(path.join(root, 'data'), notes);
  return { root, front, back, other, notes, projects, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a project needs a name, a kind and real folders, and never the whole disk or the home folder', () => {
  const t = fresh();
  try {
    assert.equal(t.projects.create({ name: '', kind: 'new' }).ok, false);
    assert.equal(t.projects.create({ name: 'x', kind: 'maybe' }).ok, false);
    assert.equal(t.projects.create({ name: 'x', kind: 'existing' }).ok, false);
    assert.equal(t.projects.create({ name: 'x', kind: 'existing', folders: [{ name: 'front', path: path.join(t.root, 'missing') }] }).ok, false);
    assert.equal(t.projects.create({ name: 'x', kind: 'existing', folders: [{ name: 'front', path: 'relative/dir' }] }).ok, false);
    assert.ok(forbiddenFolder(path.parse(t.root).root));
    assert.ok(forbiddenFolder(t.root, t.root));
    assert.ok(forbiddenFolder(path.join(t.root, '.ssh')));
    const made = t.projects.create({ name: 'فروشگاه', kind: 'existing', stack: 'React + Node', folders: [{ name: 'front', path: t.front }, { name: 'back', path: t.back }] });
    assert.ok(made.ok);
    assert.equal(made.project.status, 'intake');
    assert.equal(t.projects.create({ name: 'فروشگاه', kind: 'new' }).ok, false);
    // What goes to git is the description, without the paths.
    const md = readFileSync(path.join(t.notes, `${made.project.id}.md`), 'utf8');
    assert.match(md, /فروشگاه/);
    assert.doesNotMatch(md, new RegExp(t.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.equal(new Projects(path.join(t.root, 'data')).get(made.project.id)?.name, 'فروشگاه');
  } finally {
    t.done();
  }
});

test('each agent gets only the folders it was granted, a manager reads them all, and grants follow a new engine', () => {
  const t = fresh();
  try {
    const p = t.projects.create({ name: 'shop', kind: 'existing', folders: [{ name: 'front', path: t.front }, { name: 'back', path: t.back }] });
    assert.ok(p.ok);
    const id = p.project.id;
    assert.equal(t.projects.setGrant('fe', id, 'front', 'write').ok, true);
    assert.equal(t.projects.setGrant('fe', id, 'nope', 'write').ok, false);
    assert.equal(t.projects.setGrant('be', id, 'back', 'read').ok, true);
    assert.deepEqual(t.projects.dirsFor('fe').write.length, 1);
    assert.deepEqual(t.projects.dirsFor('fe').read, []);
    assert.equal(t.projects.dirsFor('be').read.length, 1);
    assert.equal(t.projects.dirsFor('boss', true).read.length, 2);
    assert.equal(t.projects.dirsFor('nobody').read.length + t.projects.dirsFor('nobody').write.length, 0);
    assert.equal(t.projects.access('fe', path.join(t.front, 'src', 'a.ts'))?.mode, 'write');
    assert.equal(t.projects.access('fe', path.join(t.back, 'a.ts'))?.mode, undefined);
    assert.equal(t.projects.access('fe', path.join(t.other, 'a.ts')), undefined);
    t.projects.swap('fe', 'fe2');
    assert.equal(t.projects.access('fe2', path.join(t.front, 'a.ts'))?.mode, 'write');
    t.projects.setGrant('fe2', id, 'front', 'none');
    assert.equal(t.projects.grantsOf('fe2').length, 0);
  } finally {
    t.done();
  }
});

const worker = (id: string): WorkerInfo => ({ id, name: id, kind: 'agent' }) as WorkerInfo;

function gateFloor(t: ReturnType<typeof fresh>, manager = '') {
  const requests = new TeamRequests(path.join(t.root, 'data'));
  const sent: string[] = [];
  const floor = { projects: t.projects, teams: { isManager: (id: string) => id === manager }, requests, notifier: { send: async (s: string) => void sent.push(s) } };
  return { floor: floor as never, requests, sent };
}

test('the folder guard lets an agent work in its own folder, and asks the person about any other', () => {
  const t = fresh();
  try {
    const p = t.projects.create({ name: 'shop', kind: 'existing', folders: [{ name: 'front', path: t.front }, { name: 'back', path: t.back }] });
    assert.ok(p.ok);
    assert.ok(t.projects.create({ name: 'blog', kind: 'existing', folders: [{ name: 'site', path: t.other }] }).ok);
    t.projects.setGrant('fe', p.project.id, 'front', 'write');
    t.projects.setGrant('fe', p.project.id, 'back', 'read');
    const { floor, requests, sent } = gateFloor(t, 'boss');
    const me = worker('fe');
    const write = (file: string) => folderGate(floor, me, { tool_name: 'Write', tool_input: { file_path: file }, cwd: t.root });
    // Its own folder, and a path outside every project, are fine.
    assert.equal(write(path.join(t.front, 'a.ts')), undefined);
    assert.equal(write(path.join(t.root, 'elsewhere.txt')), undefined);
    // A folder it may only read.
    assert.equal(folderGate(floor, me, { tool_name: 'Read', tool_input: { file_path: path.join(t.back, 'a.ts') }, cwd: t.root }), undefined);
    assert.match(write(path.join(t.back, 'a.ts')) ?? '', /فقط خواندنی/);
    // The project it was never given.
    assert.match(folderGate(floor, me, { tool_name: 'Read', tool_input: { file_path: path.join(t.other, 'a.ts') }, cwd: t.root }) ?? '', /./);
    assert.equal(sent.length, 2);
    // A shell command is judged by the paths in it and by where it runs.
    assert.match(folderGate(floor, me, { tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(t.back, 'b.txt')}` }, cwd: t.root }) ?? '', /./);
    assert.equal(folderGate(floor, me, { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: t.front }), undefined);
    assert.match(folderGate(floor, me, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: t.other }) ?? '', /./);
    // Secrets need the person's yes even in its own folder; the example file does not.
    assert.match(write(path.join(t.front, '.env')) ?? '', /رمز/);
    assert.equal(write(path.join(t.front, '.env.example')), undefined);
    // A manager reads every folder but writes none of them.
    const boss = worker('boss');
    assert.equal(folderGate(floor, boss, { tool_name: 'Read', tool_input: { file_path: path.join(t.other, 'a.ts') }, cwd: t.root }), undefined);
    assert.match(folderGate(floor, boss, { tool_name: 'Edit', tool_input: { file_path: path.join(t.other, 'a.ts') }, cwd: t.root }) ?? '', /./);
    // The person says yes to one folder, and it opens for that agent.
    const open = requests.open().find((r) => r.from === 'fe' && /نوشتن/.test(r.title));
    assert.ok(open);
    requests.resolve(open.id, 'done', '');
    assert.equal(write(path.join(t.back, 'a.ts')), undefined);
  } finally {
    t.done();
  }
});

test('a floor with projects asks every task it hands out which project it is for, and tags what it tells', () => {
  const t = fresh();
  try {
    const tasks = new TeamTasks(path.join(t.root, 'data'));
    const boss = { id: 'boss', name: 'مدیر', boss: true };
    const workers = [{ id: 'boss', name: 'مدیر', kind: 'agent', role: 'مدیر تیم' }, { id: 'fe', name: 'فرانت', kind: 'agent' }] as WorkerInfo[];
    // No projects on the floor: nothing changes.
    tasks.needsProject = () => t.projects.list().length > 0;
    tasks.projectOf = (k) => t.projects.find(k) && { id: t.projects.find(k)!.id, name: t.projects.find(k)!.name };
    tasks.projectName = (id) => t.projects.get(id)?.name;
    assert.equal(tasks.create(boss, { title: 'بی‌پروژه', assignee: 'فرانت' }, workers).ok, true);
    const p = t.projects.create({ name: 'shop', kind: 'new' });
    assert.ok(p.ok);
    assert.equal(tasks.create(boss, { title: 'صفحه‌ی اصلی', assignee: 'فرانت' }, workers).ok, false);
    assert.equal(tasks.create(boss, { title: 'صفحه‌ی اصلی', assignee: 'فرانت', project: 'نامعلوم' }, workers).ok, false);
    const made = tasks.create(boss, { title: 'صفحه‌ی اصلی', assignee: 'فرانت', project: 'shop' }, workers);
    assert.ok(made.ok);
    assert.equal(made.task?.project, p.project.id);
    assert.match(made.notices[0].text, /^\[پروژه: shop\]/);
  } finally {
    t.done();
  }
});

test('what an agent is told about a project task carries the folders it may use and where they are', () => {
  const t = fresh();
  try {
    const tasks = new TeamTasks(path.join(t.root, 'data'));
    const boss = { id: 'boss', name: 'مدیر', boss: true };
    const workers = [{ id: 'boss', name: 'مدیر', kind: 'agent', role: 'مدیر تیم' }, { id: 'fe', name: 'فرانت', kind: 'agent' }] as WorkerInfo[];
    const p = t.projects.create({ name: 'shop', kind: 'new', folders: [{ name: 'front', path: t.front }, { name: 'back', path: t.back }] });
    assert.ok(p.ok);
    t.projects.setGrant('fe', p.project.id, 'front', 'write');
    tasks.needsProject = () => true;
    tasks.projectOf = (k) => t.projects.find(k) && { id: t.projects.find(k)!.id, name: t.projects.find(k)!.name };
    tasks.projectName = (id) => t.projects.get(id)?.name;
    tasks.projectPaths = (worker, project) => t.projects.pathsFor(worker, project);
    const made = tasks.create(boss, { title: 'صفحه‌ی اصلی', assignee: 'فرانت', project: 'shop' }, workers);
    assert.ok(made.ok);
    assert.match(made.notices[0].text, new RegExp(`پوشه‌های تو در این پروژه: front: .*\(نوشتن\)`));
    assert.ok(!made.notices[0].text.includes(t.back), 'a folder it was not given is not named');
  } finally {
    t.done();
  }
});

test('on a floor with projects, project files and git branches are refused in the team repository itself', () => {
  const t = fresh();
  try {
    const made = t.projects.create({ name: 'shop', kind: 'new', folders: [{ name: 'front', path: t.front }] });
    assert.ok(made.ok);
    t.projects.setGrant('fe', made.project.id, 'front', 'write');
    const team = path.join(t.root, 'team');
    mkdirSync(team, { recursive: true });
    const { floor } = gateFloor(t);
    (floor as { dir?: string }).dir = team;
    const me = worker('fe');
    const write = (file: string) => folderGate(floor, me, { tool_name: 'Write', tool_input: { file_path: file }, cwd: team });
    assert.match(write('front/ideas-v2/IDEA.md') ?? '', /مخزن خود تیم/);
    assert.equal(write('freelance-team/people/x/memory.md'), undefined, 'the team files are its own');
    assert.equal(write('CLAUDE.md'), undefined);
    const shell = (command: string) => folderGate(floor, me, { tool_name: 'Bash', tool_input: { command }, cwd: team });
    assert.match(shell('git switch -c feature/P1-ui-ideas') ?? '', /شاخه/);
    assert.match(shell('git checkout -b x') ?? '', /شاخه/);
    assert.equal(shell('git branch --show-current'), undefined);
    assert.equal(shell('git status'), undefined);
    assert.equal(shell(`git -C ${t.front} switch -c feature/x`), undefined, 'a branch in the project folder is fine');
  } finally {
    t.done();
  }
});
