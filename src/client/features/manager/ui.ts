import './ui.css';
import { h, openModal, toast } from '../../ui/dom';
import { fa } from '../../ui/fa-locale';
import { openTeamMeeting } from './meeting';
import { approvalsBox, dayBar, personBox, scheduleBox, type Approval, type ScheduleItem } from './extras';

// The manager's computer: the team's tasks in columns (to do, doing, review, blocked, done), the people
// and what they're up to, a box to tell them things, and on the right whatever task you open: its notes,
// who it's with and how far along. Everything is read from, and sent to, the server every few seconds
// (see server/http/routes/team.ts), so what the manager and the team do shows up here as it happens.

interface Person { id: string; name: string; role?: string; status: string; activity?: string }
interface Note { at: number; by: string; text: string }
interface Task {
  id: string;
  title: string;
  detail: string;
  status: string;
  priority: string;
  assignee?: string;
  assigneeId?: string;
  createdBy: string;
  request?: boolean;
  due?: string;
  updatedAt: number;
  notes: Note[];
}
interface Team { manager?: { id: string; name: string }; hiringLocked?: boolean; notifyConfigured?: boolean; schedule?: ScheduleItem[]; approvals?: Approval[]; people: Person[]; tasks: Task[] }

const COLUMNS: { status: string; title: string }[] = [
  { status: 'todo', title: '📥 انجام‌نشده' },
  { status: 'doing', title: '🛠️ در حال انجام' },
  { status: 'review', title: '🔍 بازبینی' },
  { status: 'blocked', title: '⛔ گیرکرده' },
  { status: 'done', title: '✅ تمام‌شده' },
];
const PRIORITY: Record<string, string> = { low: 'کم', normal: 'عادی', high: 'مهم' };
const STATUS_FA: Record<string, string> = { todo: 'انجام‌نشده', doing: 'در حال انجام', review: 'بازبینی', blocked: 'گیرکرده', done: 'تمام‌شده', cancelled: 'لغوشده' };
const POLL_MS = 2500;

let opened = false;

export function openManager(floor: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let team: Team = { people: [], tasks: [] };
  let selected = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let drafting = false;
  /** What the side shows besides a task: the timetable, or one person being edited. */
  let panel: { kind: 'schedule' } | { kind: 'person'; id: string } | undefined;

  const people = h('div.mg-people');
  const board = h('div.mg-board');
  const side = h('div.mg-side');
  const mgr = h('select', { 'aria-label': 'مدیر تیم' }) as HTMLSelectElement;
  const msg = h('div.mg-msg', { role: 'status' });
  const title = h('h2', {}, '👑 کامپیوتر مدیر');
  const newBtn = h('button.btn', { type: 'button' }, '＋ کار تازه');
  const meetBtn = h('button.btn', { type: 'button', title: 'جلسه‌ با همین افراد، بدون استخدام' }, '🤝 جلسه‌ی تیمی');
  const lockBtn = h('button.btn', { type: 'button', title: 'وقتی قفل است هیچ ایجنتی استخدام نمی‌شود' }, '🔒 استخدام');
  const schedBtn = h('button.btn', { type: 'button', title: 'مصاحبه‌ی هفتگی، بازبینی روزانه و شروع روز، خودکار' }, '⏰ زمان‌بندی');
  const el = h('div.modal.manager-window', { role: 'dialog', 'aria-label': 'کامپیوتر مدیر', lang: 'fa', dir: 'rtl' },
    h('header', {}, title, h('span.muted', {}, 'مدیر:'), mgr, newBtn, meetBtn, schedBtn, lockBtn),
    h('div.mg-body', {}, h('div.mg-main', {}, dayBar((a, x) => call(a, x)), people, board, msg), side));
  const modal = openModal(el, { doing: 'در کامپیوتر مدیر', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const call = async (action: string, extra: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/team/${action === 'schedule' ? 'schedule' : 'action'}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      await load();
      return out;
    } catch (e) {
      msg.textContent = fa(e instanceof Error ? e.message : 'انجام نشد');
      return undefined;
    }
  };

  const card = (t: Task) => {
    const meta = h('div.meta', {},
      t.assignee ? h('span', {}, `👤 ${t.assignee}`) : h('span', {}, 'بدون مسئول'),
      t.priority === 'high' ? h('span.mg-chip.high', {}, 'مهم') : null,
      t.request ? h('span.mg-chip.req', {}, '📨 درخواست') : null,
      t.due ? h('span', {}, `⏰ ${t.due}`) : null);
    const c = h('div.mg-card', { class: t.id === selected ? 'on' : '', role: 'button', tabindex: '0', onclick: () => { selected = t.id; drafting = false; render(); } }, h('b', {}, `${t.id} · ${t.title}`), meta);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') c.click(); });
    return c;
  };

  const renderBoard = () => {
    board.replaceChildren(...COLUMNS.map((col) => {
      const list = team.tasks.filter((t) => t.status === col.status).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, col.status === 'done' ? 12 : 60);
      return h('div.mg-col', {}, h('h3', {}, h('span', {}, col.title), h('span', {}, String(list.length))), h('div.mg-cards', {}, ...(list.length ? list.map(card) : [h('div.mg-empty', {}, 'خالی')])));
    }));
  };

  const renderPeople = () => {
    people.replaceChildren(...team.people.map((p) => h('span.mg-person', { class: p.id === team.manager?.id ? 'boss' : '', title: `${p.activity ?? ''} — برای ویرایش نام و نقش بزنید`.trim(), role: 'button', tabindex: '0', onclick: () => { panel = { kind: 'person', id: p.id }; drafting = false; render(); } }, h('i', { class: p.status }), p.name, p.role ? h('small.muted', {}, ` · ${p.role.split(':')[0]}`) : null)));
    const keep = mgr.value;
    mgr.replaceChildren(...team.people.map((p) => h('option', { value: p.id }, p.name)));
    mgr.value = team.manager?.id ?? keep;
    lockBtn.textContent = team.hiringLocked ? '🔒 استخدام قفل است' : '🔓 استخدام باز است';
    lockBtn.classList.toggle('primary', !!team.hiringLocked);
  };

  const field = <T extends HTMLElement>(node: T) => node;

  /** The box to tell one person, or everyone, something. */
  const commandBox = () => {
    const to = h('select', { 'aria-label': 'به چه کسی' }, h('option', { value: 'all' }, 'همه‌ی تیم'), ...team.people.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
    const text = h('textarea', { placeholder: 'دستور یا پیام شما…', maxlength: '8000', dir: 'auto' }) as HTMLTextAreaElement;
    const send = h('button.btn.primary', { type: 'button', onclick: async () => {
      if (!text.value.trim()) return;
      const out = await call('command', { to: to.value, text: text.value });
      if (out) { toast(`فرستاده شد`); text.value = ''; }
    } }, 'ارسال دستور');
    return h('div.mg-box', {}, h('h4', {}, '📣 دستور به تیم'), to, text, send);
  };

  const newTaskBox = () => {
    const t = field(h('input', { placeholder: 'عنوان کار', maxlength: '120', dir: 'auto' }) as HTMLInputElement);
    const d = h('textarea', { placeholder: 'توضیح: چه چیزی، کجا، چه چیزی تحویل داده شود', maxlength: '4000', dir: 'auto' }) as HTMLTextAreaElement;
    const who = h('select', {}, h('option', { value: '' }, 'بدون مسئول'), ...team.people.map((p) => h('option', { value: p.name }, p.name))) as HTMLSelectElement;
    const pr = h('select', {}, h('option', { value: 'normal' }, 'اولویت عادی'), h('option', { value: 'high' }, 'اولویت مهم'), h('option', { value: 'low' }, 'اولویت کم')) as HTMLSelectElement;
    const due = h('input', { type: 'date', 'aria-label': 'موعد' }) as HTMLInputElement;
    const go = h('button.btn.primary', { type: 'button', onclick: async () => {
      if (!t.value.trim()) return;
      const out = await call('create', { title: t.value, detail: d.value, assignee: who.value, priority: pr.value, due: due.value || undefined });
      if (out) { drafting = false; render(); }
    } }, 'ساخت و ارسال به مسئول');
    return h('div.mg-box', {}, h('h4', {}, '＋ کار تازه'), t, d, who, h('div.mg-row', {}, pr, due), h('div.mg-row', {}, go, h('button.btn', { type: 'button', onclick: () => { drafting = false; render(); } }, 'بستن')));
  };

  const detailBox = (t: Task) => {
    const who = h('select', { 'aria-label': 'مسئول' }, h('option', { value: '' }, 'بدون مسئول'), ...team.people.map((p) => h('option', { value: p.name }, p.name))) as HTMLSelectElement;
    who.value = t.assignee ?? '';
    who.addEventListener('change', () => void call('update', { id: t.id, assignee: who.value }));
    const btn = (label: string, status: string, primary = false) => h('button.btn', { class: primary ? 'primary' : '', type: 'button', onclick: () => void call('update', { id: t.id, status }) }, label);
    const noteIn = h('input', { placeholder: 'یادداشت یا پرسش برای مسئول…', maxlength: '2000', dir: 'auto' }) as HTMLInputElement;
    const addNote = async () => {
      if (!noteIn.value.trim()) return;
      const out = await call('note', { id: t.id, text: noteIn.value });
      if (out) noteIn.value = '';
    };
    noteIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void addNote(); });
    return h('div.mg-box', {}, h('h4', {}, `${t.id} · ${t.title}`),
      h('div', {}, `وضعیت: ${STATUS_FA[t.status] ?? t.status} · اولویت: ${PRIORITY[t.priority] ?? t.priority}${t.due ? ` · موعد ${t.due}` : ''}`),
      h('div.muted', {}, `ساخته‌ی ${t.createdBy}${t.request ? ' (درخواست از مدیر)' : ''}`),
      t.detail ? h('div', { style: 'white-space:pre-wrap' }, t.detail) : null,
      who,
      h('div.mg-row', {}, btn('شروع', 'doing'), btn('بازبینی', 'review'), btn('✓ تأیید و بستن', 'done', true), btn('گیرکرده', 'blocked'), btn('لغو', 'cancelled')),
      h('div.mg-notes', {}, ...(t.notes.length ? t.notes.map((n) => h('div.mg-note', { dir: 'auto' }, h('b', {}, `${n.by}: `), n.text)) : [h('div.mg-empty', {}, 'یادداشتی نیست')])),
      noteIn, h('button.btn', { type: 'button', onclick: () => void addNote() }, 'افزودن یادداشت'));
  };

  const render = () => {
    renderPeople();
    renderBoard();
    const t = team.tasks.find((x) => x.id === selected);
    const back = () => { panel = undefined; render(); };
    const person = panel?.kind === 'person' ? team.people.find((x) => x.id === (panel as { id: string }).id) : undefined;
    const extra = panel?.kind === 'schedule' ? scheduleBox(team.schedule ?? [], !!team.notifyConfigured, call, back) : person ? personBox(person, call, back) : null;
    side.replaceChildren(...(approvalsBox(team.approvals ?? [], call) ? [approvalsBox(team.approvals ?? [], call) as HTMLElement] : []), commandBox(), ...(extra ? [extra] : drafting ? [newTaskBox()] : t ? [detailBox(t)] : [h('div.mg-box', {}, h('div.mg-empty', {}, 'روی یک کار بزنید تا جزئیاتش را ببینید، یا «کار تازه» را بزنید.'))]));
  };

  /** Draws only when something changed, so a half-typed note isn't wiped by the refresh. */
  let seen = '';
  const load = async () => {
    try {
      const res = await fetch(`/api/team?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as Team;
      const sig = JSON.stringify(next);
      team = next;
      if (sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (active && side.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
        renderPeople();
        renderBoard();
        return;
      }
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  };

  mgr.addEventListener('change', () => void call('manager', { worker: mgr.value }));
  newBtn.addEventListener('click', () => { drafting = true; panel = undefined; render(); });
  schedBtn.addEventListener('click', () => { panel = panel?.kind === 'schedule' ? undefined : { kind: 'schedule' }; drafting = false; render(); });
  meetBtn.addEventListener('click', () => openTeamMeeting(floor));
  lockBtn.addEventListener('click', () => void call('lock', { on: !team.hiringLocked }));
  void load().then(() => render());
  timer = setInterval(() => void load(), POLL_MS);
  return modal;
}
