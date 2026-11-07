import './projects.css';
import { h, openModal, toast } from '../../ui/dom';

// The 📁 پروژه‌ها window: the floor's projects (what each is, its folders on this computer, whether it is being looked
// at or ready), who may use which folder, and the button that starts the team's review of a project in a meeting
// (a ready-made one for a project that already exists, a full one for a new project). Read from, and sent to, the
// server (see server/http/routes/projects.ts, projects.ts, folder-gate.ts).

interface Folder { name: string; path: string }
interface Project { id: string; name: string; kind: 'existing' | 'new'; status: string; stack: string; run: string; test: string; notes: string; folders: Folder[]; open: number }
interface Agent { id: string; name: string; role: string; manager: boolean; team?: string; status: string }
interface Grant { project: string; folder: string; mode: 'read' | 'write' }
interface State { projects: Project[]; agents: Agent[]; grants: Record<string, Grant[]> }

const STATUS_FA: Record<string, string> = { intake: 'در بررسی', ready: 'آماده‌ی توسعه', active: 'در جریان', paused: 'متوقف', done: 'تمام' };
const POLL_MS = 3000;
let opened = false;

/** The meeting that starts a project: who comes and what is asked of each, by whether the project already exists. */
export function kickoffPlan(p: Pick<Project, 'name' | 'kind'>): { topic: string; agenda: string[]; mode: 'debate' } {
  if (p.kind === 'existing') {
    return {
      topic: `بررسی قبلی پروژه‌ی «${p.name}» (پروژه‌ی موجود)`,
      mode: 'debate',
      agenda: [
        'هر نفر کد و پوشه‌ی خودش را فقط بخواند و در ۵ خط بگوید: ساختار، فناوری، دستور اجرا و تست، و خطرها',
        'چه چیزی آماده است و چه چیزی باید قبل از شروع درست شود',
        'تقسیم کار پیشنهادی بین نقش‌ها و برآورد زمان (فقط آنچه شاهد دارد)',
        'چه دسترسی و اطلاعاتی کم است (مخزن، staging، ورود) و از مدیرعامل چه می‌خواهیم',
      ],
    };
  }
  return {
    topic: `بررسی کامل پروژه‌ی تازه‌ی «${p.name}»`,
    mode: 'debate',
    agenda: [
      'هر نفر از جایگاه خودش نیازمندی‌ها، ابهام‌ها و ریسک‌ها را بگوید',
      'فناوری و معماری پیشنهادی با دلیل و گزینه‌ی دیگر',
      'تجربه‌ی کاربری و رابط (جریان کاربر و نیازهای فارسی و RTL)',
      'برآورد زمان و هزینه‌ی توکن، و مراحل تحویل',
      'سؤال‌هایی که باید از کارفرما بپرسیم',
    ],
  };
}

export function openProjects(floor: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { projects: [], agents: [], grants: {} };
  let selected: string | undefined;
  let adding = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';
  let draftFolders: Folder[] = [{ name: 'front', path: '' }];
  /** Who comes to a project's review meeting (the meeting room has five chairs). */
  let invited: Set<string> | undefined;

  const list = h('div.pj-list');
  const detail = h('div.pj-detail');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.secwin.pjwin', { role: 'dialog', 'aria-label': 'پروژه‌ها', lang: 'fa', dir: 'rtl' },
    h('header', {}, h('h2', {}, '📁 پروژه‌ها'), h('button.btn.primary', { type: 'button', onclick: () => { adding = true; selected = undefined; draftFolders = [{ name: 'front', path: '' }]; render(); } }, '➕ پروژه‌ی تازه')),
    h('div.pj-body', {}, list, detail), msg);
  openModal(el, { doing: 'در بخش پروژه‌ها', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const post = async (path: string, action: string, extra: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/${path}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string; project?: string; note?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      return out;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return undefined;
    }
  };
  const act = async (action: string, extra: Record<string, unknown>) => {
    const out = await post('projects/action', action, extra);
    if (out) await load(true);
    return out;
  };

  // ---- Adding a project ----

  const addForm = () => {
    const name = h('input', { maxlength: '60', placeholder: 'نام پروژه، مثلاً فروشگاه پوشاک', dir: 'auto' }) as HTMLInputElement;
    const stack = h('input', { maxlength: '200', placeholder: 'فناوری، مثلاً React + Node + MySQL', dir: 'auto' }) as HTMLInputElement;
    const run = h('input', { maxlength: '300', placeholder: 'دستور اجرا (اختیاری)', dir: 'ltr' }) as HTMLInputElement;
    const test = h('input', { maxlength: '300', placeholder: 'دستور تست (اختیاری)', dir: 'ltr' }) as HTMLInputElement;
    const notes = h('textarea', { rows: '4', maxlength: '3000', placeholder: 'کارفرما، چه می‌خواهد، چه چیزی نباید لمس شود', dir: 'auto' }) as HTMLTextAreaElement;
    const kind = h('select', { 'aria-label': 'نوع' }, h('option', { value: 'existing' }, 'پروژه‌ی موجود (کد دارد؛ بررسی قبلی)'), h('option', { value: 'new' }, 'پروژه‌ی تازه (از اول؛ بررسی کامل)')) as HTMLSelectElement;
    const rows = h('div.pj-folders');
    const drawRows = () => rows.replaceChildren(...draftFolders.map((f, i) => {
      const n = h('input', { value: f.name, maxlength: '30', placeholder: 'front', 'aria-label': 'نام پوشه', dir: 'ltr' }) as HTMLInputElement;
      const p = h('input', { value: f.path, placeholder: 'D:\\projects\\shop\\front', 'aria-label': 'مسیر', dir: 'ltr' }) as HTMLInputElement;
      n.addEventListener('input', () => (f.name = n.value));
      p.addEventListener('input', () => (f.path = p.value));
      return h('div.mg-row', {}, n, p, h('button.btn', { type: 'button', 'aria-label': 'حذف', onclick: () => { draftFolders.splice(i, 1); drawRows(); } }, '✕'));
    }));
    drawRows();
    return h('div.hr-card', {},
      h('h3', {}, 'پروژه‌ی تازه'),
      h('label.sec-field', {}, h('span', {}, 'نام'), name),
      h('label.sec-field', {}, h('span', {}, 'نوع'), kind),
      h('label.sec-field', {}, h('span', {}, 'فناوری'), stack),
      h('div.sec-field', {}, h('span', {}, 'پوشه‌های پروژه روی این کامپیوتر (مسیر کامل؛ ریشه‌ی درایو و پوشه‌ی کاربر قبول نمی‌شود)'), rows,
        h('button.btn', { type: 'button', onclick: () => { draftFolders.push({ name: '', path: '' }); drawRows(); } }, '➕ پوشه')),
      h('label.sec-field', {}, h('span', {}, 'دستور اجرا'), run),
      h('label.sec-field', {}, h('span', {}, 'دستور تست'), test),
      h('label.sec-field', {}, h('span', {}, 'یادداشت'), notes),
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', onclick: async () => {
          const out = await act('create', { name: name.value, kind: kind.value, stack: stack.value, run: run.value, test: test.value, notes: notes.value, folders: draftFolders.filter((f) => f.name.trim() || f.path.trim()) });
          if (out) { adding = false; selected = out.project; toast('پروژه ساخته شد'); render(); }
        } }, 'ساخت پروژه'),
        h('button.btn', { type: 'button', onclick: () => { adding = false; render(); } }, 'بستن')));
  };

  // ---- One project ----

  const grantMatrix = (p: Project) => {
    if (!p.folders.length) return h('div.mg-empty', {}, 'این پروژه هنوز پوشه ندارد؛ بعد از ساخت پوشه‌ها را بدهید.');
    const rows = state.agents.map((a) => {
      const cells = p.folders.map((f) => {
        const cur = (state.grants[a.id] ?? []).find((g) => g.project === p.id && g.folder === f.name)?.mode ?? (a.manager ? 'read' : 'none');
        const sel = h('select', { 'aria-label': `${a.name} - ${f.name}` },
          h('option', { value: 'none' }, a.manager ? 'پیش‌فرض (خواندن)' : 'بدون دسترسی'), h('option', { value: 'read' }, 'خواندن'), h('option', { value: 'write' }, 'نوشتن')) as HTMLSelectElement;
        sel.value = cur;
        sel.addEventListener('change', () => void act('grant', { worker: a.id, project: p.id, folder: f.name, mode: sel.value }).then((o) => o?.note && toast(o.note)));
        return h('td', {}, sel);
      });
      return h('tr', {}, h('th', {}, h('b', {}, a.name), h('small', {}, ` ${a.role || ''}${a.manager ? ' · مدیر' : ''}`)), ...cells);
    });
    return h('table.pj-grid', {}, h('thead', {}, h('tr', {}, h('th', {}, 'ایجنت'), ...p.folders.map((f) => h('th', {}, f.name)))), h('tbody', {}, ...rows));
  };

  const projectCard = (p: Project) => {
    const status = h('select', { 'aria-label': 'وضعیت' }, ...Object.entries(STATUS_FA).map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    status.value = p.status;
    status.addEventListener('change', () => void act('update', { id: p.id, status: status.value }));
    const startReview = h('button.btn.primary', { type: 'button', title: p.kind === 'existing' ? 'هر که به کد نیاز دارد فقط می‌خواند و ۵ خط می‌گوید' : 'همه از جایگاه خود نظر می‌دهند', onclick: async () => {
      const plan = kickoffPlan(p);
      const members = [...(invited ?? [])].filter((id) => state.agents.some((a) => a.id === id));
      if (!members.length) return void (msg.textContent = 'کسانی را که باید بیایند تیک بزنید');
      if (members.length > 5) return void (msg.textContent = 'اتاق جلسه ۵ صندلی دارد؛ حداکثر ۵ نفر');
      if (!confirm(`جلسه‌ی «${plan.topic}» با ${members.length.toLocaleString('fa-IR')} نفر شروع شود؟ هر نفر در جلسه توکن مصرف می‌کند.`)) return;
      const res = await fetch(`/api/team/meeting?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', topic: plan.topic, agenda: plan.agenda.join('\n'), mode: plan.mode, rounds: 2, members }) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) { msg.textContent = out.error || 'جلسه شروع نشد'; return; }
      toast('جلسه شروع شد؛ از کامپیوتر مدیر دنبالش کنید');
    } }, p.kind === 'existing' ? '🔎 بررسی قبلی (جلسه)' : '🧩 بررسی کامل (جلسه)');
    return h('div.hr-card', {},
      h('div.sec-hh', {}, h('h3', {}, p.name), h('span.mr-chip', {}, p.kind === 'existing' ? 'موجود' : 'تازه'), h('span.mr-chip', {}, `${p.open.toLocaleString('fa-IR')} کار باز`), h('small', {}, p.id)),
      p.stack ? h('p', { dir: 'auto' }, `فناوری: ${p.stack}`) : null,
      p.run ? h('p', { dir: 'ltr' }, `اجرا: ${p.run}`) : null,
      p.test ? h('p', { dir: 'ltr' }, `تست: ${p.test}`) : null,
      p.notes ? h('p', { dir: 'auto' }, p.notes) : null,
      h('ul.pj-paths', {}, ...p.folders.map((f) => h('li', { dir: 'ltr' }, `${f.name} ← ${f.path}`))),
      h('label.sec-field', {}, h('span', {}, 'وضعیت (تسک توسعه برای پروژه‌ای که «آماده» نیست نباید ساخته شود)'), status),
      h('h4', {}, 'جلسه‌ی شروع پروژه'),
      h('div.mg-empty', {}, p.kind === 'existing' ? 'پروژه‌ی موجود: بررسی قبلی. هر نفر فقط بخشی از کد را که به کارش مربوط است می‌خواند و کوتاه می‌گوید.' : 'پروژه‌ی تازه: بررسی کامل. هر نفر از جایگاه خودش نظر می‌دهد. فقط نقش‌هایی که لازم‌اند را بیاورید.'),
      h('div.pj-picks', {}, ...state.agents.map((a) => {
        const box = h('input', { type: 'checkbox', checked: !!invited?.has(a.id) }) as HTMLInputElement;
        box.addEventListener('change', () => { invited ??= new Set(); if (box.checked) invited.add(a.id); else invited.delete(a.id); });
        return h('label.hr-pick', {}, box, h('span', {}, h('b', {}, a.name), h('small', {}, ` ${a.role || ''}`)));
      })),
      h('div.mg-row', {}, startReview),
      h('h4', {}, 'دسترسی هر ایجنت به پوشه‌ها'),
      h('div.mg-empty', {}, 'دکمه‌ی ذخیره ندارد: هر انتخاب همان لحظه ثبت می‌شود. نوشتن فقط در پوشه‌ای که بدهید؛ مدیر تیم به‌طور پیش‌فرض همه را می‌خواند. خارج از آن، ایجنت اجازه‌ی یک‌ساعته از شما می‌خواهد (📥). فایل‌های رمز (.env) همیشه از شما می‌پرسند.'),
      grantMatrix(p));
  };

  const render = () => {
    list.replaceChildren(...state.projects.map((p) => h('button.mr-tab', { type: 'button', class: selected === p.id ? 'on' : '', onclick: () => { selected = p.id; adding = false; render(); } }, `${p.name} · ${STATUS_FA[p.status] ?? p.status}`)),
      state.projects.length ? '' : h('div.mg-empty', {}, 'هنوز پروژه‌ای نیست. با «➕ پروژه‌ی تازه» اولین را بسازید.'));
    const p = state.projects.find((x) => x.id === selected);
    detail.replaceChildren(adding ? addForm() : p ? projectCard(p) : h('div.mg-empty', {}, 'یک پروژه را انتخاب کنید.'));
  };

  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && el.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  };

  async function load(force = false) {
    try {
      const res = await fetch(`/api/projects?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + (selected ?? '') + adding;
      if (!force && (sig === seen || typing())) return;
      seen = sig;
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true).then(() => { selected ??= state.projects[0]?.id; invited ??= new Set(state.agents.slice(0, 5).map((a) => a.id)); render(); });
  timer = setInterval(() => void load(), POLL_MS);
}
