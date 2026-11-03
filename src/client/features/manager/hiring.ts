import './hiring.css';
import { h, openModal, toast } from '../../ui/dom';

// The استخدام window: the map of the floor's desks (who sits where, which are free), hiring at a free desk with a
// name, a post and a description of the job, and the new agent's first interview as a chat until the person hires
// or rejects it. Read from, and sent to, the server (see server/http/routes/hiring.ts and server/team-interviews.ts).

interface Desk { id: string; label: string; x: number; z: number; rotY: number; worker?: { id: string; name: string; role?: string; status: string }; interview?: string }
interface Talk { by: 'agent' | 'boss'; text: string; at: number }
interface Interview { id: string; worker: string; name: string; role: string; desk: string; slug: string; status: 'talking' | 'review'; skill: string; messages: Talk[]; summary?: string; access?: string; skillFile?: string; memoryFile?: string }
interface State { paused: string | null; desks: Desk[]; interviews: Interview[] }

const POLL_MS = 2500;
const DESK_W = 2.2;
const DESK_D = 1.1;
let opened = false;

export function openHiring(floor: string, desk?: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { paused: null, desks: [], interviews: [] };
  let selected: string | undefined = desk;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';
  /** What is typed in the hire form stays while the window redraws. */
  const draft = { name: '', role: '', skill: '' };

  const mapBox = h('div.hr-map');
  const panel = h('div.hr-panel');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.secwin.hirewin', { role: 'dialog', 'aria-label': 'استخدام', lang: 'fa', dir: 'rtl' },
    h('header', {}, h('h2', {}, '🧑‍💼 استخدام')), h('div.hr-body', {}, panel, mapBox), msg);
  openModal(el, { doing: 'در بخش استخدام', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch(`/api/hiring/action?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      await load(true);
      return true;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return false;
    }
  };

  const interviewAt = (d: Desk) => state.interviews.find((i) => i.id === d.interview);

  // ---- The map ----

  const drawMap = () => {
    const ds = state.desks;
    if (!ds.length) return mapBox.replaceChildren(h('div.mg-empty', {}, 'میزی در این طبقه نیست.'));
    const pad = 2;
    const minX = Math.min(...ds.map((d) => d.x)) - pad, maxX = Math.max(...ds.map((d) => d.x)) + pad;
    const minZ = Math.min(...ds.map((d) => d.z)) - pad, maxZ = Math.max(...ds.map((d) => d.z)) + pad;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`);
    svg.setAttribute('class', 'hr-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'نقشه‌ی میزها');
    for (const d of ds) {
      const iv = interviewAt(d);
      const cls = d.worker ? (iv ? 'talk' : 'busy') : 'free';
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `hr-desk ${cls}${selected === d.id ? ' sel' : ''}`);
      g.setAttribute('transform', `translate(${d.x} ${d.z})`);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', d.worker ? `${d.label}: ${d.worker.name}` : `${d.label}: خالی`);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(-DESK_W / 2)); r.setAttribute('y', String(-DESK_D / 2));
      r.setAttribute('width', String(DESK_W)); r.setAttribute('height', String(DESK_D)); r.setAttribute('rx', '0.18');
      r.setAttribute('transform', `rotate(${(d.rotY * 180) / Math.PI})`);
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central'); t.setAttribute('font-size', '0.5');
      t.textContent = d.worker ? d.worker.name.split(' ')[0] : d.label.replace(/\D+/g, '') || d.label;
      g.append(r, t);
      const pick = () => { selected = d.id; render(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      svg.append(g);
    }
    mapBox.replaceChildren(
      h('div.hr-legend', {}, h('span.free', {}, 'خالی'), h('span.busy', {}, 'استخدام‌شده'), h('span.talk', {}, 'در مصاحبه')),
      svg,
      h('div.mg-empty', {}, 'برای استخدام یک میز خالی را انتخاب کنید؛ برای دیدن مصاحبه روی میز نارنجی بزنید.'));
  };

  // ---- The hire form ----

  const hireForm = (d: Desk) => {
    const name = h('input', { value: draft.name, maxlength: '40', placeholder: 'مثلاً سارا', dir: 'auto' }) as HTMLInputElement;
    const role = h('input', { value: draft.role, maxlength: '100', placeholder: 'مثلاً ایده‌یاب سئو', dir: 'auto' }) as HTMLInputElement;
    const skill = h('textarea', { rows: '7', maxlength: '3000', placeholder: 'دقیقاً چه کاری می‌کند؟ ورودی و خروجی هر کارش چیست؟ چه کارهایی نباید بکند؟', dir: 'auto' }) as HTMLTextAreaElement;
    skill.value = draft.skill;
    name.addEventListener('input', () => (draft.name = name.value));
    role.addEventListener('input', () => (draft.role = role.value));
    skill.addEventListener('input', () => (draft.skill = skill.value));
    const go = h('button.btn.primary', { type: 'button', disabled: !!state.paused, onclick: async () => {
      if (await call('hire', { desk: d.id, name: draft.name, role: draft.role, skill: draft.skill })) { draft.name = draft.role = draft.skill = ''; toast('ایجنت آمد و مصاحبه شروع شد'); }
    } }, '🎤 استخدام و شروع مصاحبه');
    return h('div.hr-card', {},
      h('h3', {}, `استخدام روی ${d.label}`),
      state.paused ? h('div.hr-warn', {}, `استخدام الان ممکن نیست: ${state.paused}`) : null,
      h('label.sec-field', {}, h('span', {}, 'نام'), name),
      h('label.sec-field', {}, h('span', {}, 'سمت'), role),
      h('label.sec-field', {}, h('span', {}, 'شرح کار و مهارت (همان چیزی که از او می‌خواهید)'), skill),
      h('div.mg-empty', {}, 'بعد از استخدام، ایجنت اول با شما مصاحبه می‌کند: خودش را معرفی می‌کند، سؤال می‌پرسد، نظرش را می‌گوید و دسترسی‌هایی را که دارد یا لازم دارد اعلام می‌کند. تا استخدام نشده به او کاری داده نمی‌شود.'),
      go);
  };

  // ---- The interview ----

  /** The chat and the reply box last drawn, so a redraw while someone types only touches the messages. */
  let chat: { id: string; list: HTMLElement; status: HTMLElement; input: HTMLTextAreaElement } | undefined;

  const bubbles = (iv: Interview) => iv.messages.length
    ? iv.messages.map((m) => h('div.hr-msg', { class: m.by }, h('b', {}, m.by === 'agent' ? iv.name : 'شما'), h('div', { dir: 'auto' }, m.text)))
    : [h('div.mg-empty', {}, `⏳ ${iv.name} در حال آماده‌شدن است و به‌زودی خودش را معرفی می‌کند…`)];

  const statusLine = (iv: Interview) => {
    const last = iv.messages[iv.messages.length - 1];
    if (iv.status === 'review') return '✅ مصاحبه تمام شد؛ نتیجه را ببینید و تصمیم بگیرید.';
    if (!last || last.by === 'boss') return `⏳ منتظر ${last ? 'پاسخ' : 'معرفی'} ${iv.name}…`;
    return '💬 منتظر پاسخ شما';
  };

  const updateChat = (iv: Interview) => {
    if (!chat || chat.id !== iv.id) return;
    const atEnd = chat.list.scrollHeight - chat.list.scrollTop - chat.list.clientHeight < 40;
    chat.list.replaceChildren(...bubbles(iv));
    chat.status.textContent = statusLine(iv);
    if (atEnd) chat.list.scrollTop = chat.list.scrollHeight;
  };

  const interviewPanel = (iv: Interview) => {
    const list = h('div.hr-chat', { role: 'log', 'aria-live': 'polite' });
    const status = h('div.hr-status');
    const input = h('textarea', { rows: '2', placeholder: 'پاسخ یا حرف شما…', dir: 'auto', maxlength: '2000' }) as HTMLTextAreaElement;
    const send = async () => { const t = input.value.trim(); if (!t) return; input.value = ''; if (!(await call('say', { id: iv.id, text: t }))) input.value = t; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } });
    chat = { id: iv.id, list, status, input };
    updateChat(iv);
    list.scrollTop = list.scrollHeight;
    const files = iv.status === 'review'
      ? h('div.hr-result', {},
        iv.summary ? h('div.hr-card', {}, h('h4', {}, 'خلاصه'), h('p', { dir: 'auto' }, iv.summary)) : null,
        iv.access ? h('div.hr-card.access', {}, h('h4', {}, '🔑 دسترسی‌ها (چه دارد و چه لازم دارد)'), h('p', { dir: 'auto' }, iv.access)) : null,
        iv.skillFile ? h('details', {}, h('summary', {}, '📄 skill.md (مهارت)'), h('pre', { dir: 'auto' }, iv.skillFile)) : null,
        iv.memoryFile ? h('details', {}, h('summary', {}, '🧠 memory.md (حافظه)'), h('pre', { dir: 'auto' }, iv.memoryFile)) : null)
      : null;
    return h('div.hr-card.interview', {},
      h('div.sec-hh', {}, h('h3', {}, `🎤 مصاحبه با ${iv.name}`), h('span.mr-chip', {}, iv.role), h('small', {}, `پوشه: freelance-team/people/${iv.slug}`)),
      list, status, h('div.hr-reply', {}, input, h('button.btn.primary', { type: 'button', onclick: () => void send() }, 'ارسال')),
      files,
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', disabled: iv.status !== 'review', title: iv.status === 'review' ? '' : 'بعد از پایان مصاحبه فعال می‌شود', onclick: () => void call('hired', { id: iv.id }) }, '✓ استخدام (برو سر میزت)'),
        iv.status === 'talking' ? h('button.btn', { type: 'button', title: 'بدون پایان مصاحبه همین‌طور استخدامش کن', onclick: () => confirm(`${iv.name} بدون پایان مصاحبه استخدام شود؟`) && void call('skip', { id: iv.id }) }, '⏭ رد شدن از مصاحبه') : null,
        h('button.btn', { type: 'button', onclick: () => confirm(`${iv.name} رد شود و برود؟ پروفایلش پاک می‌شود.`) && void call('reject', { id: iv.id }) }, '✕ رد')));
  };

  // ---- Putting it together ----

  /** Someone is typing in the panel: leave it be and only bring the chat up to date. */
  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && panel.contains(a) && ['INPUT', 'TEXTAREA'].includes(a.tagName) && !!(a as HTMLInputElement).value;
  };

  const render = () => {
    const d = state.desks.find((x) => x.id === selected);
    const iv = d ? interviewAt(d) : undefined;
    drawMap();
    chat = undefined;
    panel.replaceChildren(...(iv ? [interviewPanel(iv)]
      : d && !d.worker ? [hireForm(d)]
      : d?.worker ? [h('div.hr-card', {}, h('h3', {}, d.worker.name), h('p', {}, d.worker.role ?? 'بدون سمت'), h('div.mg-empty', {}, `${d.label} · استخدام‌شده`))]
      : [h('div.hr-card', {}, h('h3', {}, 'استخدام'), h('div.mg-empty', {}, 'یک میز خالی را روی نقشه انتخاب کنید.')),
        ...state.interviews.map((x) => h('button.mr-tab', { type: 'button', onclick: () => { selected = x.desk; render(); } }, `🎤 ${x.name} · ${x.status === 'review' ? 'منتظر تصمیم شما' : 'در مصاحبه'}`))]));
  };

  async function load(force = false) {
    try {
      const res = await fetch(`/api/hiring?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + (selected ?? '');
      if (!force && sig === seen) return;
      seen = sig;
      if (!force && typing()) {
        const live = state.interviews.find((x) => x.id === chat?.id);
        if (live) updateChat(live);
        return;
      }
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true).then(() => { if (!selected) selected = state.interviews[0]?.desk; render(); });
  timer = setInterval(() => void load(), POLL_MS);
}
