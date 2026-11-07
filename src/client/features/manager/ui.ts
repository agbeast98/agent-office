import './ui.css';
import { h, openModal, toast } from '../../ui/dom';
import { fa } from '../../ui/fa-locale';
import { openTeamMeeting } from './meeting';
import { openFlows } from './flows';
import { openHiring } from './hiring';
import { createMembers } from './members';
import { createMistakes, createRequests } from './inbox';
import { openProjects } from './projects';
import { openSecurity } from './security';
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
interface Team { requests?: number; mistakes?: number; flows?: { running: number; waiting: number }; security?: { waiting: number; asked: number }; manager?: { id: string; name: string }; hiringLocked?: boolean; notifyConfigured?: boolean; schedule?: ScheduleItem[]; approvals?: Approval[]; people: Person[]; tasks: Task[] }

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
  let page = 'overview';
  const selectedPeople = new Set<string>();
  /** What the side shows besides a task: the timetable, or one person being edited. */
  let panel: { kind: 'schedule' } | { kind: 'person'; id: string } | undefined;

  const people = h('div.mg-people');
  const requestsView = createRequests({ floor, changed: () => void load() });
  const mistakesView = createMistakes({ floor, changed: () => void load() });
  const membersView = createMembers({ floor, selected: selectedPeople, call: (action, extra) => call(action, extra), changed: () => void load(), onInvite: () => { page = 'meetings'; render(); }, onHire: () => openHiring(floor) });
  const board = h('div.mg-board');
  const side = h('div.mg-side');
  const mgr = h('select', { 'aria-label': 'مدیر تیم' }) as HTMLSelectElement;
  const msg = h('div.mg-msg', { role: 'status' });
  const title = h('h2', {}, '👑 کامپیوتر مدیر');
  const newBtn = h('button.btn', { type: 'button' }, '＋ کار تازه');
  const meetBtn = h('button.btn', { type: 'button', title: 'جلسه‌ با همین افراد، بدون استخدام' }, '🤝 جلسه‌ی تیمی');
  const lockBtn = h('button.btn', { type: 'button', title: 'وقتی قفل است هیچ ایجنتی استخدام نمی‌شود' }, '🔒 استخدام');
  const secBtn = h('button.mg-nav-item', { type: 'button', title: 'نگهبان امنیت، قوانین هر ایجنت و کارهای نگه‌داشته‌شده' }, '🛡 امنیت');
  const projBtn = h('button.mg-nav-item', { type: 'button', title: 'پروژه‌ها، پوشه‌ی هر کدام روی این کامپیوتر و دسترسی هر ایجنت به پوشه‌ها' }, '📁 پروژه‌ها');
  const hireBtn = h('button.mg-nav-item', { type: 'button', title: 'نقشه‌ی میزها، استخدام با نام و سمت و شرح کار، و مصاحبه‌ی اولیه' }, '🧑‍💼 استخدام');
  const flowBtn = h('button.mg-nav-item', { type: 'button', title: 'مدیرهای تیم و سناریوها: هر مرحله به یک نفر، با QA و برگشت' }, '🧭 روال‌ها');
  const schedBtn = h('button.btn', { type: 'button', title: 'مصاحبه‌ی هفتگی، بازبینی روزانه و شروع روز، خودکار' }, '⏰ زمان‌بندی');
  const nav = h('nav.mg-nav', { 'aria-label': 'بخش‌های مدیریت تیم' });
  const content = h('main.mg-content');
  const el = h('div.modal.manager-window', { role: 'dialog', 'aria-label': 'مدیریت تیم', lang: 'fa', dir: 'rtl' },
    h('aside.mg-rail', {}, h('div.mg-brand', {}, h('span.mg-brand-mark', {}, 'م'), h('span', {}, 'میز مدیریت'), h('small', {}, 'فضای کاری تیم')), nav,
      h('div.mg-rail-footer', {}, h('span', {}, 'مدیر تیم'), mgr, lockBtn)),
    h('section.mg-workspace', {}, h('header.mg-topbar', {}, h('div', {}, h('span.mg-eyebrow', {}, 'پنل مدیریت تیم'), title), h('div.mg-actions', {}, meetBtn, schedBtn, newBtn)), content, msg));
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
    const sec = team.security;
    secBtn.textContent = `🛡 امنیت${sec && sec.asked + sec.waiting ? ` (${sec.asked + sec.waiting})` : ''}`;
    secBtn.classList.toggle('alert', !!sec?.asked);
    flowBtn.textContent = `🧭 روال‌ها${team.flows && team.flows.running + team.flows.waiting ? ` (${team.flows.running + team.flows.waiting})` : ''}`;
    flowBtn.classList.toggle('alert', !!team.flows?.waiting);
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
    const labels = [['overview', 'نمای کلی', '⌂'], ['tasks', 'کارها', '▤'], ['people', 'اعضای تیم', '♙'], ['requests', `درخواست از شما${team.requests ? ` (${team.requests})` : ''}`, '📥'], ['mistakes', `اشتباهات${team.mistakes ? ` (${team.mistakes})` : ''}`, '⚠'], ['meetings', 'جلسه‌ها', '◷'], ['schedule', 'زمان‌بندی', '◷'], ['settings', 'تنظیمات تیم', '⚙']];
    nav.replaceChildren(...labels.map(([id, label, icon]) => h('button.mg-nav-item', { type: 'button', class: page === id ? 'active' : '', 'aria-current': page === id ? 'page' : undefined, onclick: () => { page = id; panel = id === 'schedule' ? { kind: 'schedule' } : undefined; render(); } }, h('span', { 'aria-hidden': 'true' }, icon), label)), hireBtn, projBtn, secBtn);
    const heading = labels.find(([id]) => id === page)?.[1] ?? 'نمای کلی';
    const overview = page === 'overview';
    const taskPage = page === 'tasks';
    const peoplePage = page === 'people';
    if (peoplePage) void membersView.refresh();
    if (page === 'requests') void requestsView.refresh();
    if (page === 'mistakes') void mistakesView.refresh();
    const settingsPage = page === 'settings';
    const metrics = h('section.mg-metrics', {},
      ...[['در حال انجام', team.tasks.filter(x => x.status === 'doing').length, 'فعال در تیم'], ['آمادهٔ بازبینی', team.tasks.filter(x => x.status === 'review').length, 'نیازمند بررسی'], ['منتظر تصمیم', team.tasks.filter(x => x.status === 'blocked' || x.request).length, 'نیازمند پیگیری']].map(([label, value, hint]) => h('article.mg-metric', {}, h('span', {}, String(label)), h('strong', {}, String(value)), h('small', {}, String(hint)))));
    const followup = team.tasks.filter(x => x.status === 'blocked' || x.request || x.status === 'review').slice(0, 8);
    const overviewList = h('section.mg-panel', {}, h('div.mg-panel-head', {}, h('div', {}, h('h3', {}, 'نیازمند پیگیری'), h('p', {}, 'مواردی که برای ادامه به توجه مدیر نیاز دارند')), h('button.btn', { type: 'button', onclick: () => { page = 'tasks'; render(); } }, 'همهٔ کارها')),
      ...(followup.length ? followup.map(t => h('button.mg-followup', { type: 'button', onclick: () => { selected = t.id; page = 'tasks'; drafting = false; render(); } }, h('span', {}, h('b', {}, t.title), h('small', {}, `${t.id} · ${t.assignee || 'بدون مسئول'}`)), h('span.mg-status', {}, STATUS_FA[t.status] ?? t.status))) : [h('p.mg-empty', {}, 'موردی در انتظار پیگیری نیست.') ]));
    const today = h('section.mg-panel.mg-agenda', {}, h('h3', {}, 'ترکیب تیم'), h('p', {}, `${team.people.length} عضو در این تیم`), ...team.people.slice(0, 6).map(p => h('div.mg-agenda-person', {}, h('i', { class: p.status }), h('span', {}, p.name), h('small', {}, p.role?.split(':')[0] ?? p.activity ?? 'عضو تیم'))));
    const panelBody = taskPage ? h('div.mg-task-layout', {}, board, ...(t ? [detailBox(t)] : drafting ? [newTaskBox()] : [h('section.mg-panel.mg-empty', {}, 'برای دیدن جزئیات، یک کار را انتخاب کنید.')]))
      : peoplePage ? membersView.el
      : page === 'requests' ? requestsView.el
      : page === 'mistakes' ? mistakesView.el
      : settingsPage ? h('section.mg-panel', {}, h('h3', {}, 'تنظیمات تیم'), h('label.mg-setting', {}, h('span', {}, h('b', {}, 'مدیر تیم'), h('small', {}, 'مسئول هماهنگی و پیگیری اعضا')), mgr), h('label.mg-setting', {}, h('span', {}, h('b', {}, 'استخدام'), h('small', {}, team.hiringLocked ? 'استخدام برای این تیم قفل است' : 'استخدام برای این تیم باز است')), lockBtn))
      : page === 'meetings' ? h('section.mg-panel', {}, h('h3', {}, 'جلسهٔ تیم'), h('p', {}, selectedPeople.size ? `${selectedPeople.size} عضو برای دعوت انتخاب شده‌اند.` : 'همین حالا جلسهٔ تیمی را باز کنید.'), h('button.btn.primary', { type: 'button', onclick: () => openTeamMeeting(floor) }, 'باز کردن جلسهٔ تیمی'))
      : extra ? h('section.mg-panel', {}, extra) : overview ? h('div.mg-overview-layout', {}, overviewList, today) : h('section.mg-panel', {}, scheduleBox(team.schedule ?? [], !!team.notifyConfigured, call, () => { page = 'overview'; render(); }));
    const approvals = approvalsBox(team.approvals ?? [], call);
    content.replaceChildren(h('div.mg-page-title', {}, h('div', {}, h('span.mg-eyebrow', {}, `تیم · ${floor}`), h('h2', {}, heading)), ...(overview ? [h('span.mg-live', {}, h('i'), 'اطلاعات زنده')] : [])), ...(overview ? [metrics] : []), panelBody,
      ...(settingsPage || peoplePage ? [commandBox()] : []), ...(approvals ? [approvals] : []));
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
      if (page === 'people') void membersView.refresh();
      if (page === 'requests') void requestsView.refresh();
      if (page === 'mistakes') void mistakesView.refresh();
      if (sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (active && el.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
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
  newBtn.addEventListener('click', () => { drafting = true; selected = ''; page = 'tasks'; panel = undefined; render(); });
  schedBtn.addEventListener('click', () => { page = 'schedule'; panel = { kind: 'schedule' }; drafting = false; render(); });
  secBtn.addEventListener('click', () => openSecurity(floor));
  flowBtn.addEventListener('click', () => openFlows(floor));
  hireBtn.addEventListener('click', () => openHiring(floor));
  projBtn.addEventListener('click', () => openProjects(floor));
  meetBtn.addEventListener('click', () => openTeamMeeting(floor));
  lockBtn.addEventListener('click', () => void call('lock', { on: !team.hiringLocked }));
  void load().then(() => render());
  timer = setInterval(() => void load(), POLL_MS);
  return modal;
}
