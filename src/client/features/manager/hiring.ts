import './hiring.css';
import { h, openModal, toast } from '../../ui/dom';
import { createConvo, type Convo, type ConvoMsg } from '../../ui/convo';
import { store } from '../../state';
import { agentFields, resolvedProvider } from '../../ui/provider';
import { diffBox } from './hiring-diff';
import { teamsTab } from './hiring-teams';
import { ENGINES, type Desk, type Draft, type Interview, type Proposal, type State } from './hiring-types';

// The استخدام window: the map of the floor's desks (who sits where, which are free), hiring at a free desk (alone,
// into a team, or as the manager of a new team) with a name, a post and a description of the job, and the new
// agent's first interview as a chat (with the team manager's comments) until the person hires or rejects it; and
// the تیم‌ها tab. Read from, and sent to, the server (see server/http/routes/hiring.ts, team-interviews.ts).

const POLL_MS = 2500;
const DESK_W = 2.2;
const DESK_D = 1.1;
type Tab = 'hire' | 'teams';
let opened = false;

export function openHiring(floor: string, desk?: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { paused: null, company: '', desks: [], interviews: [], teams: [], alone: [] };
  let tab: Tab = 'hire';
  let selected: string | undefined = desk;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';
  const draft: Draft = { mode: 'newteam', team: '', teamName: '', name: '', role: '', skill: '', provider: '' };

  /** The people picked for a re-interview of several at once, while that card is open. */
  let picking: Set<string> | undefined;
  const reviewAll = h('button.btn', { type: 'button', title: 'ایجنت‌ها دوباره درباره‌ی کار، قواعد و دسترسی‌شان مصاحبه می‌شوند و ارزیابی می‌شوند؛ برای همه یا هر که را انتخاب کنید', onclick: () => { picking = picking ? undefined : new Set(hired().filter((p) => !p.interview).map((p) => p.id)); tab = 'hire'; render(); } }, '🔄 مصاحبه‌ی مجدد');
  const nav = h('nav.sec-nav', { role: 'tablist' });
  const mapBox = h('div.hr-map');
  const panel = h('div.hr-panel');
  const body = h('div.hr-body', {}, panel, mapBox);
  const teamsBox = h('div.hr-teams');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.secwin.hirewin', { role: 'dialog', 'aria-label': 'استخدام', lang: 'fa', dir: 'rtl' }, h('header', {}, h('h2', {}, '🧑‍💼 استخدام'), reviewAll), nav, body, teamsBox, msg);
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

  /** A hired person as the teams list has them, with when they were last interviewed. */
  const personOf = (id: string) => [...state.teams.flatMap((t) => [t.manager, ...t.members]), ...state.alone].find((p) => p?.id === id) ?? undefined;
  /** Everyone hired on this floor (managers, members and those who work alone). */
  const hired = () => [...state.teams.flatMap((t) => (t.manager ? [t.manager] : [])), ...state.teams.flatMap((t) => t.members), ...state.alone].filter((p, k, all) => all.findIndex((q) => q.id === p.id) === k);

  /** Asks the server and returns its answer, or undefined with the reason shown. */
  const ask = async (action: string, extra: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/hiring/action?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string } & Record<string, unknown>;
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      return out;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return undefined;
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
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `hr-desk ${d.worker ? (iv ? 'talk' : 'busy') : 'free'}${selected === d.id ? ' sel' : ''}`);
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

  /** A proposal of a manager: the form filled in with it (as a member of that team). */
  const useProposal = (p: Proposal) => {
    Object.assign(draft, { mode: 'team', team: p.team, role: p.role, skill: p.skill, name: '', proposal: p.id });
    tab = 'hire';
    selected = state.desks.find((d) => !d.worker)?.id;
    render();
  };

  const hireForm = (d: Desk) => {
    if (!state.teams.some((t) => t.id === draft.team)) draft.team = state.teams[0]?.id ?? '';
    if (draft.mode === 'team' && !state.teams.length) draft.mode = 'newteam';
    const name = h('input', { value: draft.name, maxlength: '40', placeholder: 'مثلاً سارا', dir: 'auto' }) as HTMLInputElement;
    const role = h('input', { value: draft.role, maxlength: '100', placeholder: draft.mode === 'newteam' ? 'مثلاً مدیر تیم سئو' : 'مثلاً ایده‌یاب سئو', dir: 'auto' }) as HTMLInputElement;
    const skill = h('textarea', { rows: '6', maxlength: '3000', placeholder: 'دقیقاً چه کاری می‌کند؟ ورودی و خروجی هر کارش چیست؟ چه کارهایی نباید بکند؟', dir: 'auto' }) as HTMLTextAreaElement;
    skill.value = draft.skill;
    name.addEventListener('input', () => (draft.name = name.value));
    role.addEventListener('input', () => (draft.role = role.value));
    skill.addEventListener('input', () => (draft.skill = skill.value));
    const radio = (mode: Draft['mode'], label: string, hint: string, disabled = false) => {
      const r = h('input', { type: 'radio', name: 'hire-mode', checked: draft.mode === mode, disabled }) as HTMLInputElement;
      r.addEventListener('change', () => { draft.mode = mode; render(); });
      return h('label.hr-mode', { class: draft.mode === mode ? 'on' : '' }, r, h('span', {}, h('b', {}, label), h('small', {}, hint)));
    };
    const teamSel = h('select', { 'aria-label': 'تیم' }, ...state.teams.map((t) => h('option', { value: t.id }, `تیم ${t.name}${t.manager?.interview ? ' (مدیرش هنوز در مصاحبه است)' : ''}`))) as HTMLSelectElement;
    teamSel.value = draft.team;
    teamSel.addEventListener('change', () => (draft.team = teamSel.value));
    const teamName = h('input', { value: draft.teamName, maxlength: '50', placeholder: 'نام تیم، مثلاً سئو', dir: 'auto' }) as HTMLInputElement;
    teamName.addEventListener('input', () => (draft.teamName = teamName.value));
    const engine = h('select', { 'aria-label': 'موتور' }, ...ENGINES.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    engine.value = draft.provider;
    engine.addEventListener('change', () => (draft.provider = engine.value));
    const go = h('button.btn.primary', { type: 'button', disabled: !!state.paused, onclick: async () => {
      if (await call('hire', { desk: d.id, mode: draft.mode, team: draft.team, teamName: draft.teamName, name: draft.name, role: draft.role, skill: draft.skill, provider: draft.provider || undefined, proposal: draft.proposal })) {
        Object.assign(draft, { name: '', role: '', skill: '', teamName: '', proposal: undefined });
        toast('ایجنت آمد و مصاحبه شروع شد');
      }
    } }, '🎤 استخدام و شروع مصاحبه');
    return h('div.hr-card', {},
      h('h3', {}, `استخدام روی ${d.label}`),
      state.paused ? h('div.hr-warn', {}, `استخدام الان ممکن نیست: ${state.paused}`) : null,
      draft.proposal ? h('div.hr-warn.ok', {}, 'این فرم از پیشنهاد مدیر پر شده است؛ فقط نام را بنویسید.') : null,
      h('div.hr-modes', {},
        radio('newteam', '🧭 مدیر یک تیم تازه', 'اول مدیر را استخدام کنید؛ بعد با مشورت او نیروها را اضافه کنید.'),
        radio('team', '👥 عضو یک تیم', 'مدیر تیم درباره‌ی او نظر می‌دهد و فهرست تیم را می‌شناسد.', !state.teams.length),
        radio('solo', '🧍 مستقل', 'برای خودش کار می‌کند و عضو هیچ تیمی نیست.')),
      draft.mode === 'team' ? h('label.sec-field', {}, h('span', {}, 'تیم'), teamSel) : null,
      draft.mode === 'newteam' ? h('label.sec-field', {}, h('span', {}, 'نام تیم'), teamName) : null,
      h('label.sec-field', {}, h('span', {}, 'نام'), name),
      h('label.sec-field', {}, h('span', {}, 'سمت'), role),
      h('label.sec-field', {}, h('span', {}, 'شرح کار و مهارت (همان چیزی که از او می‌خواهید)'), skill),
      h('label.sec-field', {}, h('span', {}, 'با کدام موتور کار کند؟'), engine),
      h('div.mg-empty', {}, 'بعد از استخدام، ایجنت اول با شما مصاحبه می‌کند: خودش را معرفی می‌کند، سؤال می‌پرسد، نظرش را می‌گوید و دسترسی‌هایی را که دارد یا لازم دارد اعلام می‌کند. تا استخدام نشده به او کاری داده نمی‌شود.'),
      go);
  };

  // ---- The interview ----

  /** The chat last drawn, so a redraw while someone types only touches the messages. */
  let chat: { id: string; convo: Convo } | undefined;
  /** One conversation per interview, made once: the box keeps what is typed whatever the window redraws. */
  const convos = new Map<string, Convo>();

  const statusLine = (iv: Interview) => {
    const last = [...iv.messages].reverse().find((m) => m.by !== 'manager');
    if (iv.status === 'review') return '✅ مصاحبه تمام شد؛ نتیجه را ببینید و تصمیم بگیرید.';
    if (!last || last.by === 'boss') return `⏳ منتظر ${last ? 'پاسخ' : 'معرفی'} ${iv.name}…`;
    return '💬 منتظر پاسخ شما';
  };

  const messagesOf = (iv: Interview): ConvoMsg[] => iv.messages.map((m, i) => ({
    id: `${iv.id}:${i}`,
    side: m.by === 'boss' ? 'me' : 'them',
    name: m.by === 'agent' ? iv.name : m.by === 'manager' ? `مدیر ${m.who ?? ''}`.trim() : 'شما',
    sub: m.by === 'agent' ? iv.role.split(':')[0] : undefined,
    tag: m.by === 'manager' ? '🧭 نظر مدیر تیم' : undefined,
    text: m.text,
    at: m.at,
  }));

  /** The conversation of this interview, brought up to date: its messages, who is writing, what is waited for. */
  const paintChat = (iv: Interview): Convo => {
    let c = convos.get(iv.id);
    if (!c) {
      c = createConvo({
        draftKey: `interview:${iv.id}`,
        placeholder: `پاسخ یا حرف شما به ${iv.name}… (Enter ارسال، Shift+Enter خط تازه)`,
        empty: `⏳ ${iv.name} در حال آماده‌شدن است و به‌زودی خودش را معرفی می‌کند…`,
        send: (text) => call('say', { id: iv.id, text }),
      });
      convos.set(iv.id, c);
    }
    const last = [...iv.messages].reverse().find((m) => m.by !== 'manager');
    c.setMessages(messagesOf(iv));
    c.setTyping(iv.status === 'talking' && (!last || last.by === 'boss') ? [iv.name] : []);
    c.setStatus(statusLine(iv));
    c.setEnabled(iv.status === 'talking', 'مصاحبه تمام شده است');
    return c;
  };

  const updateChat = (iv: Interview) => {
    if (chat?.id === iv.id) paintChat(iv);
  };

  /** Out of the interview, back to the map of desks (the interview goes on; it is listed there). */
  const backBtn = () => h('button.btn.hr-back', { type: 'button', title: 'نقشه‌ی میزها و بقیه‌ی مصاحبه‌ها', onclick: () => { selected = undefined; render(); } }, '🗺 میزها');

  /** The interview over the whole browser window, and back; the choice stays while the window is open. */
  const fullBtn = () => {
    const on = el.classList.contains('full');
    return h('button.btn.hr-back', { type: 'button', title: on ? 'برگشت به اندازه‌ی پنجره' : 'گفتگو در تمام صفحه‌ی مرورگر', onclick: () => { el.classList.toggle('full'); render(); } }, on ? '🗗 کوچک' : '⛶ تمام‌صفحه');
  };

  const interviewPanel = (iv: Interview) => {
    const team = state.teams.find((t) => t.id === iv.team);
    const convo = paintChat(iv);
    chat = { id: iv.id, convo };
    if (iv.kind === 'review') return reviewPanel(iv, team?.name, convo);
    const files = iv.status === 'review'
      ? h('div.hr-result', {},
        iv.summary ? h('div.hr-card', {}, h('h4', {}, 'خلاصه'), h('p', { dir: 'auto' }, iv.summary)) : null,
        iv.access ? h('div.hr-card.access', {}, h('h4', {}, '🔑 دسترسی‌ها (چه دارد و چه لازم دارد)'), h('p', { dir: 'auto' }, iv.access)) : null,
        iv.skillFile ? h('details', {}, h('summary', {}, '📄 skill.md (مهارت)'), h('pre', { dir: 'auto' }, iv.skillFile)) : null,
        iv.memoryFile ? h('details', {}, h('summary', {}, '🧠 memory.md (حافظه)'), h('pre', { dir: 'auto' }, iv.memoryFile)) : null)
      : null;
    return h('div.hr-card.interview', {},
      h('div.sec-hh', {}, backBtn(), fullBtn(), h('h3', {}, `🎤 مصاحبه با ${iv.name}`), h('span.mr-chip', {}, iv.role), iv.team && team ? h('span.mr-chip', {}, iv.isManager ? `مدیر تیم ${team.name}` : `تیم ${team.name}`) : h('span.mr-chip', {}, 'مستقل'), h('small', {}, `پوشه: freelance-team/people/${iv.slug}`)),
      convo.el,
      iv.team && !iv.isManager ? h('button.btn', { type: 'button', title: 'مدیر تیم گفتگو را می‌خواند و نظر واقع‌گرایانه‌اش را همین‌جا می‌نویسد', onclick: () => void call('askManager', { id: iv.id }) }, '🧭 نظر مدیر') : null,
      files,
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', disabled: iv.status !== 'review', title: iv.status === 'review' ? '' : 'بعد از پایان مصاحبه فعال می‌شود', onclick: () => void call('hired', { id: iv.id }) }, '✓ استخدام (برو سر میزت)'),
        iv.status === 'talking' ? h('button.btn', { type: 'button', title: 'بدون پایان مصاحبه همین‌طور استخدامش کن', onclick: () => confirm(`${iv.name} بدون پایان مصاحبه استخدام شود؟`) && void call('skip', { id: iv.id }) }, '⏭ رد شدن از مصاحبه') : null,
        h('button.btn', { type: 'button', onclick: () => confirm(`${iv.name} رد شود و برود؟ پروفایلش پاک می‌شود.`) && void call('reject', { id: iv.id }) }, '✕ رد')));
  };

  /** A re-interview: the agent is asked about its own work, then the person sees what it proposes to change next to the profile it has. */
  const reviewPanel = (iv: Interview, teamName: string | undefined, convo: Convo) => {
    const p = iv.proposal;
    const result = iv.status === 'review' && p && iv.before
      ? h('div.hr-result', {},
        iv.summary ? h('div.hr-card', {}, h('h4', {}, 'خلاصه'), h('p', { dir: 'auto' }, iv.summary)) : null,
        h('div.hr-card.review', {}, h('h4', {}, '🔄 تغییرهای پیشنهادی (با دلیل و شاهد)'), h('p.hr-changes', { dir: 'auto' }, p.changes)),
        iv.access ? h('div.hr-card.access', {}, h('h4', {}, '🔑 دسترسی‌ها'), h('p', { dir: 'auto' }, iv.access)) : null,
        diffBox('📄 skill.md', iv.before.skill, p.skill),
        diffBox('🧠 memory.md', iv.before.memory, p.memory))
      : null;
    return h('div.hr-card.interview', {},
      h('div.sec-hh', {}, backBtn(), fullBtn(), h('h3', {}, `🔄 مصاحبه‌ی مجدد با ${iv.name}`), h('span.mr-chip', {}, iv.role.split(':')[0]), h('span.mr-chip', {}, iv.team && teamName ? (iv.isManager ? `مدیر تیم ${teamName}` : `تیم ${teamName}`) : 'مستقل')),
      h('div.mg-empty', {}, 'ایجنت درباره‌ی کار خودش جواب می‌دهد: فلو، بایدها و نبایدها، تأییدها، دسترسی‌ها و اشتباه‌ها. می‌توانید سؤال یا اصلاح بفرستید. در پایان پیشنهاد تغییر می‌دهد؛ تا شما تأیید نکنید چیزی نوشته نمی‌شود.'),
      convo.el,
      iv.team && !iv.isManager ? h('button.btn', { type: 'button', title: 'مدیر تیم گفتگو را می‌خواند و نظرش را همین‌جا می‌نویسد', onclick: () => void call('askManager', { id: iv.id }) }, '🧭 نظر مدیر') : null,
      result,
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', disabled: iv.status !== 'review', title: iv.status === 'review' ? '' : 'بعد از پایان مصاحبه فعال می‌شود', onclick: () => confirm(`پیشنهاد ${iv.name} روی پروفایلش اعمال شود؟`) && void call('apply', { id: iv.id }) }, '✓ اعمال تغییرها'),
        h('button.btn', { type: 'button', onclick: () => confirm(`پروفایل ${iv.name} همان‌طور که هست بماند و مصاحبه بسته شود؟`) && void call('keep', { id: iv.id }) }, '✕ پروفایل بدون تغییر بماند')));
  };

  /** When someone was last interviewed, for the person's card. */
  const lastSeen = (t?: number) => {
    if (!t) return 'هنوز مصاحبه نشده';
    const days = Math.floor((Date.now() - t) / 86_400_000);
    return days < 1 ? 'آخرین مصاحبه: امروز' : `آخرین مصاحبه: ${days.toLocaleString('fa-IR')} روز پیش${days >= 30 ? ' ⚠️' : ''}`;
  };

  /** The card for a re-interview of several: everyone hired, ticked, and one button. */
  const chooserCard = () => {
    const people = hired();
    const boxes = people.map((p) => {
      const box = h('input', { type: 'checkbox', checked: !!picking?.has(p.id) && !p.interview, disabled: !!p.interview }) as HTMLInputElement;
      box.addEventListener('change', () => (box.checked ? picking?.add(p.id) : picking?.delete(p.id)));
      return h('label.hr-pick', {}, box, h('span', {}, h('b', {}, p.name), h('small', {}, ` ${(p.role ?? '').split(':')[0] || 'بدون سمت'} · ${lastSeen(p.interviewedAt)}${p.interview ? ' · الان در مصاحبه' : ''}`)));
    });
    return h('div.hr-card.review', {},
      h('h3', {}, '🔄 مصاحبه‌ی مجدد (ارزیابی و به‌روزرسانی)'),
      h('div.mg-empty', {}, 'هر ایجنت درباره‌ی کار خودش پرسیده و ارزیابی می‌شود: فلو، بایدها و نبایدها، تأییدها، دسترسی‌ها، اشتباه‌ها و نقطه‌های قوت و ضعف. مدیر تیم هم نظر و ارزیابی خودش را ثبت می‌کند. در پایان هر نفر تغییرهای پیشنهادی را می‌فرستد و تا شما تأیید نکنید چیزی نوشته نمی‌شود. تا پایان مصاحبه کار تازه نمی‌گیرند.'),
      people.length ? h('div.hr-picks', {}, ...boxes) : h('div.mg-empty', {}, 'هنوز کسی استخدام نشده است.'),
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', disabled: !people.length, onclick: async () => {
          const ids = [...(picking ?? [])];
          if (!ids.length) return void (msg.textContent = 'حداقل یک نفر را انتخاب کنید');
          if (!confirm(`مصاحبه‌ی مجدد برای ${ids.length.toLocaleString('fa-IR')} نفر شروع شود؟`)) return;
          const out = await ask('reviewMany', { workers: ids });
          if (out) { picking = undefined; toast('مصاحبه‌ی مجدد شروع شد'); await load(true); }
        } }, '🔄 شروع برای انتخاب‌شده‌ها'),
        h('button.btn', { type: 'button', onclick: () => { picking = undefined; render(); } }, 'بستن')));
  };

  /** Another engine, model or reasoning effort for the same person; it takes up where they were (an interview too). */
  const enginePanel = (worker: string, name: string) => {
    const p = personOf(worker);
    const fields = agentFields(store.project, `hr-agent-${worker}`, { provider: resolvedProvider(p?.provider as never, store.project) }, 'موتور', 'fa');
    const go = h('button.btn', { type: 'button', onclick: async () => {
      if (!fields.valid()) return;
      if (!confirm(`${name} از میزش بلند می‌شود و با موتور و مدل تازه دوباره می‌آید؛ پروفایل و جایش در تیم می‌ماند${state.interviews.some((x) => x.worker === worker) ? ' و مصاحبه از همین‌جا ادامه پیدا می‌کند' : ''}. ادامه؟`)) return;
      go.setAttribute('disabled', '');
      if (await call('switch', { worker, provider: fields.value(), model: fields.model(), effort: fields.effort() })) toast(`${name} با موتور تازه دوباره آمد`);
      go.removeAttribute('disabled');
    } }, '⚙️ اعمال موتور و مدل');
    return h('details.hr-card', {}, h('summary', {}, `⚙️ موتور و مدل ${name}`), fields.element, h('div.mg-empty', {}, 'روی «پیش‌فرض» بماند تا مدل پیش‌فرض همان موتور استفاده شود.'), h('div.mg-row', {}, go));
  };

  /** Firing, in two steps: the first says what it means, the second wants the name typed. */
  const fire = async (worker: string, name: string) => {
    const first = await ask('fireAsk', { worker });
    if (!first) return;
    const tasks = Number(first.openTasks) || 0;
    if (!confirm(`مرحله‌ی ۱ از ۲\n\n${name} اخراج شود؟${first.team ? `\nاز تیم «${String(first.team)}» برداشته می‌شود.` : ''}${tasks ? `\nاو ${tasks.toLocaleString('fa-IR')} کار باز دارد که بی‌صاحب می‌ماند.` : ''}\nاز میزش می‌رود؛ پروفایلش در مخزن می‌ماند.`)) return;
    const typed = prompt(`مرحله‌ی ۲ از ۲\n\nبرای تأیید نهایی، نام «${name}» را دقیقاً بنویسید:`);
    if (typed === null) return;
    if (await call('fire', { worker, name: typed })) toast(`${name} اخراج شد`);
  };

  /** The card of a hired person at a desk: when they were last interviewed, a new interview, their engine, and firing. */
  const workerCard = (d: Desk) => {
    const w = d.worker!;
    return h('div.hr-card', {},
      h('h3', {}, w.name),
      h('p', {}, (w.role ?? 'بدون سمت').split(':')[0]),
      h('div.mg-empty', {}, `${d.label} · استخدام‌شده · ${lastSeen(personOf(w.id)?.interviewedAt)}`),
      h('div.mg-row', {},
        h('button.btn', { type: 'button', title: 'ایجنت درباره‌ی کار، قواعد و دسترسی‌هایش پرسیده و ارزیابی می‌شود و تغییر پیشنهاد می‌دهد؛ تا تأیید نکنید چیزی عوض نمی‌شود', onclick: () => confirm(`مصاحبه‌ی مجدد با ${w.name} شروع شود؟ تا پایان مصاحبه کار تازه نمی‌گیرد.`) && void call('review', { worker: w.id }) }, '🔄 مصاحبه‌ی مجدد'),
        h('button.btn.danger', { type: 'button', title: 'اخراج با تأیید دومرحله‌ای', onclick: () => void fire(w.id, w.name) }, '🚪 اخراج')),
      enginePanel(w.id, w.name));
  };

  // ---- Putting it together ----

  /** Someone is typing here: leave it be and only bring the chat up to date. */
  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && el.contains(a) && ['INPUT', 'TEXTAREA'].includes(a.tagName) && (!!a.closest('.cv') || !!(a as HTMLInputElement).value);
  };

  // ---- The business, written once for everyone ----

  /** What is typed into the business box and not saved yet, so a redraw does not lose it. */
  let companyDraft: string | undefined;

  const companyCard = () => {
    const text = h('textarea', { rows: '8', maxlength: '12000', dir: 'auto', placeholder: 'کسب‌وکار، خدمت‌ها، بازار، رقبا، قوانین…' }) as HTMLTextAreaElement;
    text.value = companyDraft ?? state.company;
    text.addEventListener('input', () => (companyDraft = text.value));
    const filled = state.company.replace(/\(.*?\)/g, '').replace(/[#\s\-]/g, '').length > 120;
    return h('details.hr-card.company', { open: !filled || companyDraft !== undefined },
      h('summary', {}, `📘 کسب‌وکار شما، برای همه‌ی نیروها${filled ? '' : ' (هنوز خالی است)'}`),
      h('div.mg-empty', {}, 'هر ایجنت تازه اول این را می‌خواند و همان چیزها را دوباره نمی‌پرسد. چیزهایی که در مصاحبه‌ها یاد می‌گیرند زیر «افزوده‌ها» به آن اضافه می‌کنند.'),
      text,
      h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('company', { text: text.value })) { companyDraft = undefined; toast('ذخیره شد'); } } }, 'ذخیره'));
  };

  const render = () => {
    const waiting = state.teams.reduce((n, t) => n + t.proposals.length, 0);
    const tabs: [Tab, string][] = [['hire', '🎤 استخدام و مصاحبه'], ['teams', `👥 تیم‌ها${waiting ? ` (${waiting} پیشنهاد)` : ''}`]];
    nav.replaceChildren(...tabs.map(([id, label]) => h('button.mr-tab', { type: 'button', role: 'tab', class: id === tab ? 'on' : '', onclick: () => { tab = id; render(); } }, label)));
    body.hidden = tab !== 'hire';
    teamsBox.hidden = tab !== 'teams';
    chat = undefined;
    if (tab === 'teams') return teamsBox.replaceChildren(...teamsTab(state, call, useProposal));
    const d = state.desks.find((x) => x.id === selected);
    const iv = d ? interviewAt(d) : undefined;
    // An interview has the whole window: the map only takes room from what is being read.
    body.classList.toggle('talk', !!iv && !picking);
    if (!iv || picking) el.classList.remove('full');
    drawMap();
    panel.replaceChildren(...(picking ? [chooserCard()]
      : iv ? [interviewPanel(iv), enginePanel(iv.worker, iv.name)]
      : d && !d.worker ? [companyCard(), hireForm(d)]
      : d?.worker ? [workerCard(d)]
      : [companyCard(), h('div.hr-card', {}, h('h3', {}, 'استخدام'), h('div.mg-empty', {}, state.teams.length ? 'یک میز خالی را روی نقشه انتخاب کنید.' : 'یک میز خالی را روی نقشه انتخاب کنید و اولین نفر را «مدیر یک تیم تازه» استخدام کنید.')),
        ...state.interviews.map((x) => h('button.mr-tab', { type: 'button', onclick: () => { selected = x.desk; render(); } }, `🎤 ${x.name} · ${x.status === 'review' ? 'منتظر تصمیم شما' : 'در مصاحبه'}`))]));
  };

  async function load(force = false) {
    try {
      const res = await fetch(`/api/hiring?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + (selected ?? '') + tab;
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
