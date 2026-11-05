import './meeting.css';
import { h, openModal, toast } from '../../ui/dom';
import { fa } from '../../ui/fa-locale';
import { meetingChat, modeBar, people, roundStrip } from './meeting-chat';
import { createStart } from './meeting-start';
import { keepFields } from '../../ui/fieldkeep';
import { CHAIRS, MODES, MODE_FA, type Full, type Mode, type State } from './meeting-model';
import { agenda, detail, history, notes, results } from './meeting-work';

// The meeting room's window: calling a meeting (a subject, an agenda, who comes), and while it is on, its
// sections: the conversation, the people at the table, the agenda, what came of it, your own notes, and the
// earlier meetings. Everything is read from, and sent to, the server every couple of seconds (see
// server/http/routes/team-meeting.ts), so what the team says shows up here as they say it.

const POLL_MS = 1500;
type Tab = 'chat' | 'people' | 'agenda' | 'results' | 'notes' | 'past';
const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: '💬 گفتگو' }, { id: 'people', label: '👥 حاضران' }, { id: 'agenda', label: '📋 دستور جلسه' },
  { id: 'results', label: '✅ تصمیم‌ها و کارها' }, { id: 'notes', label: '🗒 یادداشت من' }, { id: 'past', label: '🗂 سوابق' },
];

let opened = false;

export function openTeamMeeting(floor: string, special?: () => void) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { people: [], past: [] };
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';
  let tab: Tab = 'chat';
  let reading: string | undefined;

  const nav = h('nav.mr-nav', { role: 'tablist', 'aria-label': 'بخش‌های جلسه' });
  const main = h('div.mr-main');
  const msg = h('div.mg-msg', { role: 'status' });
  const pill = h('span.mr-pill');
  const endBtn = h('button.btn', { type: 'button' }, '✓ پایان جلسه');
  const title = h('h2', {}, '🤝 اتاق جلسه');
  const chat = meetingChat(floor, (a, x) => act(a, x));
  const start = createStart(floor, {
    start: async (p) => {
      if (!(await act('start', { ...p }))) return false;
      tab = 'chat';
      toast('جلسه شروع شد؛ همه سر میز نشستند');
      return true;
    },
    open: (id) => { reading = id; tab = 'past'; void load(true); },
    special,
    say: (text) => { msg.textContent = text; },
  });
  const el = h('div.modal.meetroom', { role: 'dialog', 'aria-label': 'اتاق جلسه', lang: 'fa', dir: 'rtl' },
    h('header', {}, title, pill, endBtn), h('div.mr-body', {}, nav, h('div.mr-pane', {}, main)), msg);
  openModal(el, { doing: 'در اتاق جلسه', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  async function act(action: string, extra: Record<string, unknown> = {}) {
    try {
      const res = await fetch(`/api/team/meeting?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string; notSeated?: { name: string; why: string }[] };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.replaceChildren(...(out.notSeated?.length ? [
        'این‌ها سر میز نشستند ولی جایشان نشد: ',
        ...out.notSeated.flatMap((x, i) => [
          ...(i ? ['، '] : []),
          h('bdi', { dir: 'auto' }, x.name),
          ` (${fa(x.why)})`,
        ]),
      ] : []));
      await load(true);
      return true;
    } catch (e) {
      msg.textContent = fa(e instanceof Error ? e.message : 'انجام نشد');
      return false;
    }
  }

  const live = (m: Full) => {
    if (tab === 'chat') return [roundStrip(m, state, (id) => chat.askOne(id)), modeBar(m, act), chat.convo.el].filter((x): x is NonNullable<typeof x> => !!x);
    if (tab === 'people') return [people(m, state, act, (id) => { tab = 'chat'; render(); chat.askOne(id); })];
    if (tab === 'agenda') return [agenda(m, act)];
    if (tab === 'results') return [results(m, state.people.filter((p) => m.members.some((x) => x.id === p.id)), act)];
    if (tab === 'notes') return [notes(m, act)];
    return [pastView()];
  };

  const pastView = () => (reading && state.detail?.id === reading ? detail(state.detail, floor, () => { reading = undefined; render(); }) : h('div.mr-sec', {}, h('h4', {}, '🗂 جلسه‌های قبلی'), history(state.past, (id) => { reading = id; void load(true); })));

  const badge = (id: Tab, m?: Full) => (m ? ({ chat: m.said.filter((s) => !s.note).length, people: m.members.length, agenda: m.agenda.length, results: m.decisions.length + m.taskList.length, notes: m.said.filter((s) => s.note).length, past: state.past.length } as Record<Tab, number>)[id] : 0);

  const render = (toEnd = true) => {
    const m = state.current;
    const keep = main.scrollTop;
    title.textContent = m ? `🤝 ${m.topic}` : '🤝 اتاق جلسه';
    pill.textContent = m ? `● ${MODE_FA[m.mode]} · دور ${m.round}` : 'آماده';
    pill.className = `mr-pill ${m ? 'on' : ''}`;
    endBtn.toggleAttribute('hidden', !m);
    nextBtn.hidden = m?.mode === 'vote';
    nextBtn.toggleAttribute('disabled', !!m && !m.said.some((s) => s.round === m.round && !s.note && s.id));
    nextBtn.title = nextBtn.hasAttribute('disabled') ? 'هنوز کسی در این دور چیزی نگفته' : 'نظرهای این دور را به همه می‌دهد تا جواب بدهند';
    nextBtn.textContent = m?.mode === 'debate' ? '⏭ دور بعد (زودتر)' : '↻ دور بعد';
    if (m && tab === 'chat') chat.sync(m, state);
    if (!m) start.sync(state.people, state.past);
    nav.replaceChildren(...(m ? TABS : [TABS[5]]).map((t) => h('button.mr-tab', { type: 'button', role: 'tab', class: t.id === tab || (!m && t.id === 'past') ? 'on' : '', 'aria-selected': String(t.id === tab), onclick: () => { tab = t.id; if (t.id !== 'past') reading = undefined; render(); } }, t.label, badge(t.id, m) ? h('span.mr-badge', {}, String(badge(t.id, m))) : null)));
    nav.toggleAttribute('hidden', !m);
    const content = m ? live(m) : [start.el];
    const inChat = !!m && tab === 'chat';
    main.classList.toggle('is-chat', inChat);
    // The conversation keeps its own place; the other sections are redrawn with what is typed in them put back.
    if (inChat && main.contains(chat.convo.el)) {
      // The conversation stays in the page (taking it out would put it back at the top); only what is around it changes.
      for (const c of [...main.children]) if (c !== chat.convo.el) c.remove();
      for (const n of content.slice(0, -1)) main.insertBefore(n, chat.convo.el);
    } else if (inChat || !m) main.replaceChildren(...content);
    else {
      keepFields(main, () => main.replaceChildren(...content));
      main.scrollTop = keep;
    }
  };

  endBtn.addEventListener('click', () => { if (confirm('جلسه تمام شود؟ صورت‌جلسه ذخیره می‌شود و همه به میزشان برمی‌گردند.')) void act('end').then((ok) => ok && (tab = 'chat')); });
  // The summary asks the manager; next round asks everyone: both live with the conversation.
  const nextBtn = h('button.btn', { type: 'button', title: 'نظرهای این دور را به همه می‌دهد تا جواب بدهند', onclick: () => void act('next') }, '↻ دور بعد');
  const actions = h('div.mr-acts', {},
    nextBtn,
    h('button.btn', { type: 'button', title: 'پیام جلسه را دوباره برای کسانی که هنوز چیزی نگفته‌اند می‌فرستد', onclick: () => void act('nudge').then((ok) => ok && toast('یادآوری فرستاده شد')) }, '🔔 یادآوری به ساکت‌ها'),
    h('button.btn', { type: 'button', title: 'از مدیر می‌خواهد تصمیم‌ها و کارهای بعدی را بنویسد', onclick: () => void act('summarise').then((ok) => ok && toast('از مدیر جمع‌بندی خواسته شد')) }, '📝 جمع‌بندی توسط مدیر'));
  chat.addAction(actions);

  async function load(force = false) {
    try {
      const res = await fetch(`/api/team/meeting?${qs}${reading ? `&id=${encodeURIComponent(reading)}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + tab + (reading ?? '');
      if (!force && sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (!force && active && main.contains(active) && tab !== 'chat' && !!state.current && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && (active as HTMLInputElement).value) return;
      render(main.scrollHeight - main.scrollTop - main.clientHeight < 80);
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true);
  timer = setInterval(() => void load(), POLL_MS);
}
