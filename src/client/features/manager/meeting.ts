import './meeting.css';
import { h, openModal, toast } from '../../ui/dom';
import { composer, feed, people, roundStrip } from './meeting-chat';
import { CHAIRS, type Full, type State } from './meeting-model';
import { agenda, detail, history, notes, results } from './meeting-work';

// The meeting room's window: calling a meeting (a subject, an agenda, who comes), and while it is on, its
// sections: the conversation, the people at the table, the agenda, what came of it, your own notes, and the
// earlier meetings. Everything is read from, and sent to, the server every couple of seconds (see
// server/http/routes/team-meeting.ts), so what the team says shows up here as they say it.

const POLL_MS = 2000;
const TOPICS = ['گزارش وضعیت هر نفر', 'برنامه‌ی این هفته', 'بررسی نتایج و نکات یادگرفته‌شده', 'مشکلات و گرفتاری‌ها'];
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
  const dock = composer((a, x) => act(a, x));
  const el = h('div.modal.manager-window.meetroom', { role: 'dialog', 'aria-label': 'اتاق جلسه', lang: 'fa', dir: 'rtl' },
    h('header', {}, title, pill, endBtn), h('div.mr-body', {}, nav, h('div.mr-pane', {}, main, dock.el)), msg);
  openModal(el, { doing: 'در اتاق جلسه', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  async function act(action: string, extra: Record<string, unknown> = {}) {
    try {
      const res = await fetch(`/api/team/meeting?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      await load(true);
      return true;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return false;
    }
  }

  const startForm = () => {
    const topic = h('textarea', { placeholder: 'موضوع جلسه: چه چیزی باید به نتیجه برسد؟', maxlength: '400', dir: 'auto', rows: '2' }) as HTMLTextAreaElement;
    const items = h('textarea', { placeholder: 'دستور جلسه (هر خط یک مورد، اختیاری)', maxlength: '3000', dir: 'auto', rows: '3' }) as HTMLTextAreaElement;
    const count = h('span.muted');
    const boxes = state.people.map((p) => {
      const cb = h('input', { type: 'checkbox', value: p.id, onchange: () => update() }) as HTMLInputElement;
      return { cb, row: h('label.mr-pick', {}, cb, h('span.mr-dot', { class: p.status }), ` ${p.name}`, p.role ? h('small', {}, p.role.split(':')[0]) : null) };
    });
    const update = () => {
      const n = boxes.filter((b) => b.cb.checked).length;
      count.textContent = `${n} از ${CHAIRS} صندلی`;
      go.toggleAttribute('disabled', n < 1 || n > CHAIRS);
    };
    const gather = () => { boxes.forEach((b, i) => { b.cb.checked = i < CHAIRS; }); update(); };
    const go = h('button.btn.primary', { type: 'button', onclick: async () => {
      const members = boxes.filter((b) => b.cb.checked).map((b) => b.cb.value);
      if (!topic.value.trim()) return void (msg.textContent = 'موضوع جلسه را بنویسید');
      if (await act('start', { topic: topic.value, agenda: items.value, members })) { tab = 'chat'; toast('جلسه شروع شد؛ همه سر میز نشستند'); }
    } }, '🤝 شروع جلسه');
    const nobody = state.people.length === 0;
    update();
    return h('div.mr-start', {},
      h('div.mr-sec', {}, h('h4', {}, 'جلسه‌ی تازه'), topic,
        h('div.mr-chips', {}, ...TOPICS.map((t) => h('button.mr-topic', { type: 'button', onclick: () => { topic.value = t; } }, t))), items,
        h('div.mr-who-row', {}, h('h4', {}, 'چه کسانی بیایند؟'), count, h('button.btn', { type: 'button', onclick: gather }, '👥 جمع کردن همه')),
        nobody ? h('div.mg-empty', {}, 'کسی در تیم نیست.') : h('div.mr-picks', {}, ...boxes.map((b) => b.row)),
        h('div.mg-empty', {}, 'همه سر میز اتاق جلسه می‌نشینند و کسی استخدام نمی‌شود.'), go,
        special ? h('button.btn.mr-special', { type: 'button', title: 'گروه‌های بحث و بازبینی با ایجنت‌های موقت (استخدام لازم دارد)', onclick: special }, '🧩 جلسه‌ی ویژه (گروه‌های بازبینی و بحث)') : null),
      h('div.mr-sec', {}, h('h4', {}, '🗂 جلسه‌های قبلی'), history(state.past, (id) => { reading = id; tab = 'past'; void load(true); })));
  };

  const live = (m: Full) => {
    if (tab === 'chat') return [roundStrip(m, state), feed(m, state)];
    if (tab === 'people') return [people(m, state, act, (id) => { tab = 'chat'; render(); dock.askOne(id); })];
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
    pill.textContent = m ? `● در جریان · دور ${m.round}` : 'آماده';
    pill.className = `mr-pill ${m ? 'on' : ''}`;
    endBtn.toggleAttribute('hidden', !m);
    dock.el.hidden = !(m && tab === 'chat');
    if (m) dock.sync(m);
    nav.replaceChildren(...(m ? TABS : [TABS[5]]).map((t) => h('button.mr-tab', { type: 'button', role: 'tab', class: t.id === tab || (!m && t.id === 'past') ? 'on' : '', 'aria-selected': String(t.id === tab), onclick: () => { tab = t.id; if (t.id !== 'past') reading = undefined; render(); } }, t.label, badge(t.id, m) ? h('span.mr-badge', {}, String(badge(t.id, m))) : null)));
    nav.toggleAttribute('hidden', !m);
    const content = m ? live(m) : [startForm()];
    main.replaceChildren(...content);
    if (tab === 'chat' && m) main.scrollTop = toEnd ? main.scrollHeight : keep;
  };

  endBtn.addEventListener('click', () => { if (confirm('جلسه تمام شود؟ صورت‌جلسه ذخیره می‌شود و همه به میزشان برمی‌گردند.')) void act('end').then((ok) => ok && (tab = 'chat')); });
  // The summary asks the manager; next round asks everyone: both live with the conversation.
  const actions = h('div.mr-acts', {},
    h('button.btn', { type: 'button', title: 'نظرهای این دور را به همه می‌دهد تا جواب بدهند', onclick: () => void act('next') }, '↻ دور بعد'),
    h('button.btn', { type: 'button', title: 'از مدیر می‌خواهد تصمیم‌ها و کارهای بعدی را بنویسد', onclick: () => void act('summarise').then((ok) => ok && toast('از مدیر جمع‌بندی خواسته شد')) }, '📝 جمع‌بندی توسط مدیر'));
  dock.el.append(actions);

  async function load(force = false) {
    try {
      const res = await fetch(`/api/team/meeting?${qs}${reading ? `&id=${encodeURIComponent(reading)}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + tab + (reading ?? '');
      if (!force && sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (!force && active && main.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && (active as HTMLInputElement).value) return;
      render(main.scrollHeight - main.scrollTop - main.clientHeight < 80);
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true);
  timer = setInterval(() => void load(), POLL_MS);
}
