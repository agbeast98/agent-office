import { h } from '../../ui/dom';
import { CHAIRS, MODES, type Mode, type PastRow, type Person } from './meeting-model';
import { history } from './meeting-work';

// Calling a meeting: the subject, the agenda, how it goes and who comes. It is made once and kept, so what is typed
// stays while the window reads the office again every second; the draft is also kept in the browser, so closing
// the window or reloading the page does not lose it either.

const TOPICS = ['گزارش وضعیت هر نفر', 'برنامه‌ی این هفته', 'بررسی نتایج و نکات یادگرفته‌شده', 'مشکلات و گرفتاری‌ها'];

interface Draft { mode: Mode; rounds: number; topic: string; items: string; picked: string[] }
export interface StartPayload { topic: string; agenda: string; members: string[]; mode: Mode; rounds: number }

export interface StartView {
  el: HTMLElement;
  /** Brings the list of people and earlier meetings up to date without touching what was typed. */
  sync(people: Person[], past: PastRow[]): void;
}

export function createStart(floor: string, opts: { start(payload: StartPayload): Promise<boolean>; open(id: string): void; special?: () => void; say(text: string): void }): StartView {
  const key = `meeting-draft:${floor}`;
  const draft: Draft = (() => {
    try {
      return { mode: 'poll', rounds: 3, topic: '', items: '', picked: [], ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Draft>) };
    } catch {
      return { mode: 'poll', rounds: 3, topic: '', items: '', picked: [] };
    }
  })();
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(draft));
    } catch {
      // The draft lives as long as this window.
    }
  };

  const topic = h('textarea', { placeholder: 'موضوع جلسه: چه چیزی باید به نتیجه برسد؟', maxlength: '400', dir: 'auto', rows: '2', 'aria-label': 'موضوع جلسه' }) as HTMLTextAreaElement;
  const items = h('textarea', { placeholder: 'دستور جلسه (هر خط یک مورد، اختیاری)', maxlength: '3000', dir: 'auto', rows: '4', 'aria-label': 'دستور جلسه' }) as HTMLTextAreaElement;
  topic.value = draft.topic;
  items.value = draft.items;
  topic.addEventListener('input', () => { draft.topic = topic.value; save(); });
  items.addEventListener('input', () => { draft.items = items.value; save(); });

  const rounds = h('select', { 'aria-label': 'تعداد دورها' }, ...[2, 3, 4, 5].map((n) => h('option', { value: String(n) }, `${n} دور`))) as HTMLSelectElement;
  rounds.value = String(draft.rounds);
  rounds.addEventListener('change', () => { draft.rounds = Number(rounds.value); save(); });
  const cards = MODES.map((x) => h('button.mr-mode-card', { type: 'button', class: x.id === draft.mode ? 'on' : '', 'aria-pressed': String(x.id === draft.mode), onclick: () => { draft.mode = x.id; save(); paintMode(); } }, h('b', {}, `${x.icon} ${x.title}`), h('small', {}, x.text)));
  const paintMode = () => {
    cards.forEach((c, i) => { c.classList.toggle('on', MODES[i].id === draft.mode); c.setAttribute('aria-pressed', String(MODES[i].id === draft.mode)); });
    rounds.hidden = draft.mode !== 'debate';
  };

  const count = h('span.muted');
  const picks = h('div.mr-picks');
  const go = h('button.btn.primary', { type: 'button' }, '🤝 شروع جلسه') as HTMLButtonElement;
  let people: Person[] = [];
  const pickedNow = () => draft.picked.filter((id) => people.some((p) => p.id === id));
  const update = () => {
    const n = pickedNow().length;
    count.textContent = `${n} از ${CHAIRS} صندلی`;
    go.toggleAttribute('disabled', n < 1 || n > CHAIRS);
  };
  const drawPeople = () => {
    picks.replaceChildren(...(people.length ? people.map((p) => {
      const cb = h('input', { type: 'checkbox', value: p.id, checked: draft.picked.includes(p.id), onchange: () => {
        draft.picked = cb.checked ? [...new Set([...draft.picked, p.id])] : draft.picked.filter((x) => x !== p.id);
        save();
        update();
      } }) as HTMLInputElement;
      return h('label.mr-pick', {}, cb, h('span.mr-dot', { class: p.status }), ` ${p.name}`, p.role ? h('small', {}, p.role.split(':')[0]) : null);
    }) : [h('div.mg-empty', {}, 'کسی در تیم نیست.')]));
    update();
  };
  const gather = h('button.btn', { type: 'button', onclick: () => { draft.picked = people.slice(0, CHAIRS).map((p) => p.id); save(); drawPeople(); } }, '👥 جمع کردن همه');
  go.addEventListener('click', async () => {
    if (!topic.value.trim()) return opts.say('موضوع جلسه را بنویسید');
    go.setAttribute('disabled', '');
    const ok = await opts.start({ topic: topic.value, agenda: items.value, members: pickedNow(), mode: draft.mode, rounds: draft.rounds });
    if (ok) {
      draft.topic = '';
      draft.items = '';
      topic.value = '';
      items.value = '';
      save();
    }
    update();
  });

  const pastBox = h('div.mr-sec');
  let seen = '';
  paintMode();
  const el = h('div.mr-start', {},
    h('div.mr-sec', {}, h('h4', {}, 'جلسه‌ی تازه'), h('div.mr-modes', {}, ...cards), rounds, topic,
      h('div.mr-chips', {}, ...TOPICS.map((t) => h('button.mr-topic', { type: 'button', onclick: () => { topic.value = t; draft.topic = t; save(); topic.focus(); } }, t))), items,
      h('div.mr-who-row', {}, h('h4', {}, 'چه کسانی بیایند؟'), count, gather), picks,
      h('div.mg-empty', {}, 'همه سر میز اتاق جلسه می‌نشینند و کسی استخدام نمی‌شود.'), go,
      opts.special ? h('button.btn.mr-special', { type: 'button', title: 'گروه‌های بحث و بازبینی با ایجنت‌های موقت (استخدام لازم دارد)', onclick: opts.special }, '🧩 جلسه‌ی ویژه (گروه‌های بازبینی و بحث)') : null),
    pastBox);

  return {
    el,
    sync(next, past) {
      const sig = JSON.stringify([next.map((p) => [p.id, p.name, p.status]), past.map((p) => [p.id, p.topic])]);
      if (sig === seen) return;
      seen = sig;
      people = next;
      drawPeople();
      pastBox.replaceChildren(h('h4', {}, '🗂 جلسه‌های قبلی'), history(past, opts.open));
    },
  };
}
