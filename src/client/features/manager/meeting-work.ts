import { h, toast } from '../../ui/dom';
import { clock, day, STATUS_FA, type Act, type Full, type PastRow, type Person } from './meeting-model';

// The rest of the meeting room: its agenda, what came of it (the manager's summary, the decisions, the
// tasks it made), the person's own notes, and the earlier meetings with their minutes.

const empty = (text: string) => h('div.mg-empty', {}, text);

export function agenda(m: Full, act: Act) {
  const add = h('input', { placeholder: 'یک مورد تازه برای دستور جلسه…', maxlength: '300', dir: 'auto' }) as HTMLInputElement;
  const send = async () => { if (add.value.trim() && (await act('agenda', { add: add.value }))) add.value = ''; };
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
  const done = m.agenda.filter((a) => a.done).length;
  return h('div.mr-sec', {},
    h('h4', {}, `📋 دستور جلسه${m.agenda.length ? ` · ${done} از ${m.agenda.length}` : ''}`),
    ...(m.agenda.length ? m.agenda.map((a, i) => h('label.mr-check', { class: a.done ? 'on' : '' }, h('input', { type: 'checkbox', checked: a.done, onchange: () => void act('agenda', { toggle: i }) }), a.text)) : [empty('دستور جلسه خالی است. موردها را اضافه کنید تا هر نفر بداند درباره‌ی چه حرف بزند.')]),
    h('div.mg-row', {}, add, h('button.btn', { type: 'button', onclick: () => void send() }, '＋ افزودن')));
}

/** The summary, the decisions and the tasks, with what's needed to add a decision or a task right here. */
export function results(m: Full, people: Person[], act: Act) {
  const dec = h('input', { placeholder: 'تصمیم تازه…', maxlength: '600', dir: 'auto' }) as HTMLInputElement;
  const decide = async () => { if (dec.value.trim() && (await act('decide', { text: dec.value }))) dec.value = ''; };
  dec.addEventListener('keydown', (e) => { if (e.key === 'Enter') void decide(); });

  const title = h('input', { placeholder: 'عنوان کار', maxlength: '120', dir: 'auto' }) as HTMLInputElement;
  const who = h('select', { 'aria-label': 'مسئول' }, h('option', { value: '' }, 'بدون مسئول'), ...people.map((p) => h('option', { value: p.name }, p.name))) as HTMLSelectElement;
  const pr = h('select', { 'aria-label': 'اولویت' }, h('option', { value: 'normal' }, 'عادی'), h('option', { value: 'high' }, 'مهم'), h('option', { value: 'low' }, 'کم')) as HTMLSelectElement;
  const make = async () => {
    if (!title.value.trim()) return;
    if (await act('task', { title: title.value, assignee: who.value, priority: pr.value })) { title.value = ''; toast('کار ساخته شد'); }
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') void make(); });

  return h('div.mr-cols', {},
    h('div.mr-sec', {}, h('h4', {}, '📝 جمع‌بندی مدیر'),
      m.summary ? h('div.mr-summary', { dir: 'auto' }, m.summary) : empty('هنوز نوشته نشده. «جمع‌بندی توسط مدیر» را در گفتگو بزنید.'),
      h('h4', {}, `📌 تصمیم‌ها (${m.decisions.length})`),
      ...(m.decisions.length ? m.decisions.map((d, i) => h('div.mr-decision', { dir: 'auto' }, h('b', {}, `${i + 1}`), d.text, h('small', {}, `${d.by} · ${clock(d.at)}`))) : [empty('تصمیمی ثبت نشده.')]),
      h('div.mg-row', {}, dec, h('button.btn', { type: 'button', onclick: () => void decide() }, 'ثبت تصمیم'))),
    h('div.mr-sec', {}, h('h4', {}, `✅ کارهای این جلسه (${m.taskList.length})`),
      ...(m.taskList.length ? m.taskList.map((t) => h('div.mr-task', {}, h('b', {}, `${t.id} · ${t.title}`), h('small', {}, `${t.assignee ? `👤 ${t.assignee} · ` : ''}${STATUS_FA[t.status] ?? t.status}`))) : [empty('کاری از این جلسه ساخته نشده.')]),
      h('h4', {}, '＋ کار تازه از همین جلسه'), title, h('div.mg-row', {}, who, pr), h('button.btn.primary', { type: 'button', onclick: () => void make() }, 'ساخت و ارسال به مسئول')));
}

/** The person's own notes: no one else is told them. */
export function notes(m: Full, act: Act) {
  const text = h('textarea', { placeholder: 'یادداشت شخصی شما از این جلسه (به ایجنت‌ها گفته نمی‌شود)…', maxlength: '3000', dir: 'auto' }) as HTMLTextAreaElement;
  const mine = m.said.filter((s) => s.note);
  return h('div.mr-sec', {}, h('h4', {}, '🗒 یادداشت‌های من'),
    ...(mine.length ? mine.map((n) => h('div.mg-note', { dir: 'auto' }, h('small', {}, clock(n.at)), ` ${n.text}`)) : [empty('یادداشتی ندارید.')]),
    text, h('button.btn', { type: 'button', onclick: async () => { if (text.value.trim() && (await act('note', { text: text.value }))) text.value = ''; } }, 'ذخیره‌ی یادداشت'));
}

/** One meeting in full, for reading later. */
export function detail(m: Full, floor: string, back: () => void) {
  const rounds = [...new Set(m.said.filter((s) => !s.note).map((s) => s.round))].sort((a, b) => a - b);
  return h('div.mr-detail', {},
    h('div.mg-row', {}, h('button.btn', { type: 'button', onclick: back }, '→ بازگشت'),
      m.minutes ? h('a.btn', { href: `/api/team/meeting/minutes?floor=${encodeURIComponent(floor)}&id=${m.id}`, download: `${m.id}.md` }, '⬇ دانلود صورت‌جلسه') : null),
    h('h3', {}, m.topic), h('div.muted', {}, `${day(m.startedAt)} · ${clock(m.startedAt)} · ${m.members.map((x) => x.name).join('، ')}`),
    m.summary ? h('div.mr-summary', { dir: 'auto' }, m.summary) : null,
    m.decisions.length ? h('div.mr-sec', {}, h('h4', {}, '📌 تصمیم‌ها'), ...m.decisions.map((d, i) => h('div.mr-decision', { dir: 'auto' }, h('b', {}, `${i + 1}`), d.text))) : null,
    m.taskList.length ? h('div.mr-sec', {}, h('h4', {}, '✅ کارها'), ...m.taskList.map((t) => h('div.mr-task', {}, h('b', {}, `${t.id} · ${t.title}`), h('small', {}, `${t.assignee ?? ''} ${STATUS_FA[t.status] ?? t.status}`)))) : null,
    h('div.mr-sec', {}, h('h4', {}, '💬 گفتگو'), ...rounds.flatMap((r) => [h('div.mr-round', {}, h('span', {}, `دور ${r}`)), ...m.said.filter((s) => s.round === r && !s.note).map((s) => h('div.mg-note', { dir: 'auto' }, h('b', {}, `${s.by}${s.to ? ` ← ${s.to.name}` : ''}: `), s.text))])));
}

/** The earlier meetings, newest first. */
export function history(past: PastRow[], open: (id: string) => void) {
  if (!past.length) return empty('هنوز جلسه‌ای برگزار نشده.');
  return h('div.mr-past', {}, ...past.map((p) => h('button.mr-prow', { type: 'button', onclick: () => open(p.id) },
    h('b', {}, p.topic), h('small', {}, `${day(p.startedAt)} · ${p.members.join('، ')}`),
    h('span.mr-counts', {}, `💬 ${p.said}`, p.decisions ? ` · 📌 ${p.decisions}` : '', p.tasks ? ` · ✅ ${p.tasks}` : ''),
    p.summary ? h('small.mr-sum', { dir: 'auto' }, p.summary.slice(0, 140)) : null)));
}
