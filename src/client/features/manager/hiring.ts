import './hiring.css';
import { h, openModal, toast } from '../../ui/dom';
import { createConvo, type Convo, type ConvoMsg } from '../../ui/convo';
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

  const nav = h('nav.sec-nav', { role: 'tablist' });
  const mapBox = h('div.hr-map');
  const panel = h('div.hr-panel');
  const body = h('div.hr-body', {}, panel, mapBox);
  const teamsBox = h('div.hr-teams');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.secwin.hirewin', { role: 'dialog', 'aria-label': 'استخدام', lang: 'fa', dir: 'rtl' }, h('header', {}, h('h2', {}, '🧑‍💼 استخدام')), nav, body, teamsBox, msg);
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

  const interviewPanel = (iv: Interview) => {
    const team = state.teams.find((t) => t.id === iv.team);
    const convo = paintChat(iv);
    chat = { id: iv.id, convo };
    const files = iv.status === 'review'
      ? h('div.hr-result', {},
        iv.summary ? h('div.hr-card', {}, h('h4', {}, 'خلاصه'), h('p', { dir: 'auto' }, iv.summary)) : null,
        iv.access ? h('div.hr-card.access', {}, h('h4', {}, '🔑 دسترسی‌ها (چه دارد و چه لازم دارد)'), h('p', { dir: 'auto' }, iv.access)) : null,
        iv.skillFile ? h('details', {}, h('summary', {}, '📄 skill.md (مهارت)'), h('pre', { dir: 'auto' }, iv.skillFile)) : null,
        iv.memoryFile ? h('details', {}, h('summary', {}, '🧠 memory.md (حافظه)'), h('pre', { dir: 'auto' }, iv.memoryFile)) : null)
      : null;
    return h('div.hr-card.interview', {},
      h('div.sec-hh', {}, h('h3', {}, `🎤 مصاحبه با ${iv.name}`), h('span.mr-chip', {}, iv.role), iv.team && team ? h('span.mr-chip', {}, iv.isManager ? `مدیر تیم ${team.name}` : `تیم ${team.name}`) : h('span.mr-chip', {}, 'مستقل'), h('small', {}, `پوشه: freelance-team/people/${iv.slug}`)),
      convo.el,
      iv.team && !iv.isManager ? h('button.btn', { type: 'button', title: 'مدیر تیم گفتگو را می‌خواند و نظر واقع‌گرایانه‌اش را همین‌جا می‌نویسد', onclick: () => void call('askManager', { id: iv.id }) }, '🧭 نظر مدیر') : null,
      files,
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', disabled: iv.status !== 'review', title: iv.status === 'review' ? '' : 'بعد از پایان مصاحبه فعال می‌شود', onclick: () => void call('hired', { id: iv.id }) }, '✓ استخدام (برو سر میزت)'),
        iv.status === 'talking' ? h('button.btn', { type: 'button', title: 'بدون پایان مصاحبه همین‌طور استخدامش کن', onclick: () => confirm(`${iv.name} بدون پایان مصاحبه استخدام شود؟`) && void call('skip', { id: iv.id }) }, '⏭ رد شدن از مصاحبه') : null,
        h('button.btn', { type: 'button', onclick: () => confirm(`${iv.name} رد شود و برود؟ پروفایلش پاک می‌شود.`) && void call('reject', { id: iv.id }) }, '✕ رد')));
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
    drawMap();
    panel.replaceChildren(...(iv ? [interviewPanel(iv)]
      : d && !d.worker ? [companyCard(), hireForm(d)]
      : d?.worker ? [h('div.hr-card', {}, h('h3', {}, d.worker.name), h('p', {}, (d.worker.role ?? 'بدون سمت').split(':')[0]), h('div.mg-empty', {}, `${d.label} · استخدام‌شده`))]
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
