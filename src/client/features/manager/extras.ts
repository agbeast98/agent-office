import { h, toast } from '../../ui/dom';

// The manager's computer, the parts beside the board: what waits for your say-so, the buttons for the day
// (start, report, stop), the timetable, and renaming a person. Each draws from the team the server sent
// (see server/http/routes/team.ts) and sends through the same `call` as the rest of the window.

export interface Approval { workerId: string; name: string; label: string; url: string; risky?: boolean }
export interface ScheduleItem { id: string; title: string; enabled: boolean; days: number[]; time: string }
export interface Person { id: string; name: string; role?: string }

export type Call = (action: string, extra: Record<string, unknown>) => Promise<{ error?: string } | undefined>;

/** Saturday first, as the Iranian week goes. Values are `Date.getDay()`. */
const DAYS: [number, string][] = [[6, 'ش'], [0, 'ی'], [1, 'د'], [2, 'س'], [3, 'چ'], [4, 'پ'], [5, 'ج']];

/** Everything waiting for the person, across the team's browsers, with a button for each answer. */
export function approvalsBox(list: Approval[], call: Call) {
  if (!list.length) return null;
  const rows = list.map((a) => h('div.mg-approval', { class: a.risky ? 'risky' : '' },
    h('div', {}, h('b', {}, `${a.name}: `), `«${a.label}»`, a.risky ? h('span.mg-chip.high', {}, 'پرداخت/حذف: فقط خودتان') : null),
    h('div.muted', { dir: 'ltr', style: 'font-size:11px;word-break:break-all' }, a.url),
    h('div.mg-row', {},
      h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('approval', { worker: a.workerId, verdict: 'allow' })) toast('تأیید شد'); } }, '✓ تأیید'),
      h('button.btn', { type: 'button', onclick: () => void call('approval', { worker: a.workerId, verdict: 'deny' }) }, '✕ رد'))));
  return h('div.mg-box.mg-approvals', {}, h('h4', {}, `⏳ منتظر تأیید شما (${list.length})`), ...rows);
}

/** Start the day, ask for the day's report, stop everyone. */
export function dayBar(call: Call) {
  const act = (label: string, title: string, action: string, done: string, ask?: string) =>
    h('button.btn', { type: 'button', title, onclick: async () => {
      if (ask && !confirm(ask)) return;
      if (await call(action, {})) toast(done);
    } }, label);
  return h('div.mg-row.mg-day', {},
    act('▶ شروع روز کاری', 'مدیر قوانین را می‌خواند و کارهای امروز را بین تیم پخش می‌کند', 'workday', 'به مدیر گفته شد'),
    act('📊 گزارش امروز', 'مدیر وضعیت کارها را در چند خط می‌نویسد', 'report', 'از مدیر گزارش خواسته شد'),
    act('⏹ توقف همه', 'کاری را که ایجنت‌ها در دست دارند قطع می‌کند (Esc)', 'stop', 'قطع شد', 'کار همه‌ی ایجنت‌ها قطع شود؟'));
}

/** The timetable: which days and at what time each thing happens by itself, while the office is running. */
export function scheduleBox(items: ScheduleItem[], notifyConfigured: boolean, call: Call, back: () => void) {
  const rows = items.map((i) => {
    const on = h('input', { type: 'checkbox', checked: i.enabled, 'aria-label': i.title }) as HTMLInputElement;
    const time = h('input', { type: 'time', value: i.time, 'aria-label': 'ساعت' }) as HTMLInputElement;
    const days = DAYS.map(([d, label]) => {
      const cb = h('input', { type: 'checkbox', checked: i.days.includes(d), 'aria-label': `روز ${label}` }) as HTMLInputElement;
      return { d, cb, el: h('label.mg-day-pick', {}, cb, label) };
    });
    const save = () => void call('schedule', { id: i.id, enabled: on.checked, time: time.value, days: days.filter((x) => x.cb.checked).map((x) => x.d) });
    for (const e of [on, time, ...days.map((x) => x.cb)]) e.addEventListener('change', save);
    return h('div.mg-sched', {}, h('label', {}, on, ` ${i.title}`), h('div.mg-row', {}, time, ...days.map((x) => x.el)));
  });
  return h('div.mg-box', {}, h('h4', {}, '⏰ زمان‌بندی (فقط وقتی دفتر روشن است)'), ...rows,
    h('div.muted', {}, notifyConfigured ? '📱 اعلان تلگرام فعال است.' : '📱 اعلان گوشی: فایل notify.json (telegramToken و chatId) را در پوشه‌ی داده بسازید.'),
    h('button.btn', { type: 'button', onclick: back }, 'بستن'));
}

/** Rename a person or change the role they are reminded of. */
export function personBox(p: Person, call: Call, back: () => void) {
  const name = h('input', { value: p.name, maxlength: '60', dir: 'auto', 'aria-label': 'نام' }) as HTMLInputElement;
  const role = h('textarea', { maxlength: '300', dir: 'auto', 'aria-label': 'نقش' }) as HTMLTextAreaElement;
  role.value = p.role ?? '';
  return h('div.mg-box', {}, h('h4', {}, '✏️ ویرایش عضو تیم'), name, role,
    h('div.muted', {}, 'نقش به‌صورت یادآوری در هر پیام به او داده می‌شود؛ شرح کامل در فایل نقش است.'),
    h('div.mg-row', {},
      h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('person', { worker: p.id, name: name.value, role: role.value })) { toast('ذخیره شد'); back(); } } }, 'ذخیره'),
      h('button.btn', { type: 'button', onclick: back }, 'بستن')));
}
