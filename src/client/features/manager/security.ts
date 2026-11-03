import './security.css';
import { h, openModal, toast } from '../../ui/dom';

// The security window: which agents are guarded and by whom (a security agent guards at most five), each one's
// rules, what is held waiting for a decision, and what the firewall has learned from the person's answers.
// Read from, and sent to, the server every few seconds (see server/http/routes/security.ts).

interface Rules { browse: boolean; search: boolean; write: string[]; web: string[]; blocked: string[]; commands: string[]; paths: string[] }
interface Agent { id: string; name: string; role?: string; guardian?: string; isGuardian: boolean; rules: Rules }
interface Hold { id: string; agent: { id: string; name: string }; kind: string; target: string; detail: string; at: number; status: 'pending' | 'asked' | 'allowed' | 'denied'; by?: string; note?: string }
interface State { max: number; guardians: { id: string; name: string; guarding: string[] }[]; agents: Agent[]; holds: Hold[]; learned: { key: string; verdict: 'allow' | 'deny'; at: number }[] }

const KIND_FA: Record<string, string> = { open: 'باز کردن سایت', write: 'ارسال یا ورود در سایت', web: 'دریافت صفحه', search: 'جستجوی وب', shell: 'دستور ترمینال', file: 'فایل بیرون از پوشه‌ها', tool: 'ابزار' };
const STATUS_FA = { pending: 'منتظر امنیت', asked: 'امنیت از شما می‌پرسد', allowed: 'مجاز شد', denied: 'رد شد' } as const;
const POLL_MS = 2500;
type Tab = 'agents' | 'holds' | 'learned';

let opened = false;

export function openSecurity(floor: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { max: 5, guardians: [], agents: [], holds: [], learned: [] };
  let tab: Tab = 'holds';
  let editing: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';

  const nav = h('nav.sec-nav', { role: 'tablist' });
  const main = h('div.sec-main');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.manager-window.secwin', { role: 'dialog', 'aria-label': 'امنیت', lang: 'fa', dir: 'rtl' },
    h('header', {}, h('h2', {}, '🛡 امنیت')), nav, main, msg);
  openModal(el, { doing: 'در بخش امنیت', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch(`/api/security/action?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
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

  const lines = (list: string[]) => list.join('\n');
  const area = (label: string, value: string[], hint: string) => {
    const t = h('textarea', { rows: '3', dir: 'ltr', placeholder: hint, 'aria-label': label }) as HTMLTextAreaElement;
    t.value = lines(value);
    return { t, row: h('label.sec-field', {}, h('span', {}, label), t) };
  };

  const rulesEditor = (a: Agent) => {
    const browse = h('input', { type: 'checkbox', checked: a.rules.browse }) as HTMLInputElement;
    const search = h('input', { type: 'checkbox', checked: a.rules.search }) as HTMLInputElement;
    const write = area('ارسال، ورود و بارگذاری فقط در این سایت‌ها', a.rules.write, 'khateweb.com');
    const web = area('دریافت صفحه (بیرون از مرورگر) از', a.rules.web, 'example.com');
    const blocked = area('سایت‌های ممنوع', a.rules.blocked, 'evil.example');
    const commands = area('دستورهای ترمینال مجاز (شروع دستور)', a.rules.commands, 'git status');
    const paths = area('پوشه‌های اضافه (علاوه بر پوشه‌ی کار خودش)', a.rules.paths, 'D:\\shared');
    return h('div.sec-rules', {},
      h('label.sec-check', {}, browse, ' مرور سایت‌ها (فقط خواندن) آزاد باشد'),
      h('label.sec-check', {}, search, ' جستجوی وب آزاد باشد'),
      write.row, web.row, blocked.row, commands.row, paths.row,
      h('div.mg-row', {},
        h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('rules', { agent: a.id, browse: browse.checked, search: search.checked, write: write.t.value, web: web.t.value, blocked: blocked.t.value, commands: commands.t.value, paths: paths.t.value })) { toast('قوانین ذخیره شد'); editing = undefined; render(); } } }, 'ذخیره'),
        h('button.btn', { type: 'button', onclick: () => { editing = undefined; render(); } }, 'بستن')));
  };

  const agentsTab = () => {
    const gs = state.guardians;
    return [
      h('div.mg-empty', {}, `نگهبان امنیت فقط وقتی کاری نگه داشته شود بیدار می‌شود و حداکثر ${state.max} ایجنت را زیر نظر دارد. ایجنت‌هایی که تیک ندارند آزادند.`),
      ...state.agents.map((a) => {
        const sec = h('select', { 'aria-label': 'زیر نظر کدام نگهبان', disabled: a.isGuardian }, h('option', { value: '' }, 'آزاد (بدون نگهبان)'),
          ...gs.filter((g) => g.id !== a.id).map((g) => h('option', { value: g.id }, `${g.name} (${g.guarding.length} از ${state.max})`))) as HTMLSelectElement;
        sec.value = a.guardian ?? '';
        sec.addEventListener('change', () => void (sec.value ? call('guard', { agent: a.id, guardian: sec.value, on: true }) : call('guard', { agent: a.id, guardian: a.guardian ?? '', on: false })));
        const make = h('input', { type: 'checkbox', checked: a.isGuardian, disabled: !!a.guardian || (a.isGuardian && (gs.find((g) => g.id === a.id)?.guarding.length ?? 0) > 0), title: 'این ایجنت نگهبان امنیت باشد' }) as HTMLInputElement;
        make.addEventListener('change', () => void call('guardian', { worker: a.id, on: make.checked }));
        return h('div.sec-row', { class: a.isGuardian ? 'guardian' : a.guardian ? 'guarded' : '' },
          h('div.sec-who', {}, h('b', {}, a.name), a.role ? h('small', {}, a.role.split(':')[0]) : null),
          h('label.sec-check', {}, make, ' نگهبان امنیت'),
          sec,
          a.guardian ? h('button.btn', { type: 'button', onclick: () => { editing = editing === a.id ? undefined : a.id; render(); } }, '⚙ قوانین') : null,
          editing === a.id ? rulesEditor(a) : null);
      }),
    ];
  };

  const holdCard = (x: Hold) => {
    const open = x.status === 'pending' || x.status === 'asked';
    const note = h('input', { placeholder: 'یادداشت (اختیاری)', maxlength: '300', dir: 'auto' }) as HTMLInputElement;
    return h('div.sec-hold', { class: x.status },
      h('div.sec-hh', {}, h('b', {}, x.agent.name), h('span.mr-chip', {}, KIND_FA[x.kind] ?? x.kind), h('span.sec-st', { class: x.status }, STATUS_FA[x.status]), h('small', {}, `${x.id} · ${new Date(x.at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}`)),
      h('div.sec-target', { dir: 'ltr' }, x.target),
      x.detail && x.detail !== x.target ? h('div.sec-detail', { dir: 'ltr' }, x.detail) : null,
      x.note ? h('div.sec-note', { dir: 'auto' }, `${x.by === 'you' ? 'شما' : 'امنیت'}: ${x.note}`) : null,
      open ? h('div.mg-row', {}, note,
        h('button.btn.primary', { type: 'button', title: 'یک ساعت مجاز؛ اگر دو بار همین را بگویید قانون دائمی می‌شود', onclick: () => void call('decide', { id: x.id, verdict: 'allow', note: note.value }) }, '✓ مجاز'),
        h('button.btn', { type: 'button', title: 'اگر دو بار همین را بگویید دیگر پرسیده نمی‌شود و ممنوع می‌ماند', onclick: () => void call('decide', { id: x.id, verdict: 'deny', note: note.value }) }, '✕ رد')) : null);
  };

  const holdsTab = () => {
    const wait = state.holds.filter((x) => x.status === 'pending' || x.status === 'asked').sort((a, b) => Number(b.status === 'asked') - Number(a.status === 'asked'));
    const done = state.holds.filter((x) => x.status === 'allowed' || x.status === 'denied');
    return [
      wait.length ? h('div.sec-sec', {}, h('h4', {}, `⏳ منتظر تصمیم (${wait.length})`), ...wait.map(holdCard)) : h('div.mg-empty', {}, 'چیزی نگه داشته نشده است. وقتی ایجنتی کاری بیرون از قوانینش بخواهد، همین‌جا می‌آید.'),
      done.length ? h('div.sec-sec', {}, h('h4', {}, 'تصمیم‌های قبلی'), ...done.slice(0, 40).map(holdCard)) : null,
    ].filter((x): x is NonNullable<typeof x> => !!x);
  };

  const learnedTab = () => [
    h('div.mg-empty', {}, 'وقتی دو بار برای یک سایت یا دستور یک جواب بدهید، اینجا قانون می‌شود و دیگر از شما پرسیده نمی‌شود.'),
    ...(state.learned.length ? state.learned.map((l) => h('div.sec-row', {}, h('span.sec-st', { class: l.verdict === 'allow' ? 'allowed' : 'denied' }, l.verdict === 'allow' ? 'مجاز' : 'ممنوع'), h('span.sec-target', { dir: 'ltr' }, l.key), h('button.btn', { type: 'button', onclick: () => void call('forget', { key: l.key }) }, 'فراموش کن'))) : [h('div.mg-empty', {}, 'هنوز چیزی یاد گرفته نشده.')]),
  ];

  const render = () => {
    const open = state.holds.filter((x) => x.status === 'pending' || x.status === 'asked').length;
    const tabs: [Tab, string][] = [['holds', `⏳ نگه‌داشته‌ها${open ? ` (${open})` : ''}`], ['agents', '👥 ایجنت‌ها و قوانین'], ['learned', `🧠 یادگرفته‌ها${state.learned.length ? ` (${state.learned.length})` : ''}`]];
    nav.replaceChildren(...tabs.map(([id, label]) => h('button.mr-tab', { type: 'button', role: 'tab', class: id === tab ? 'on' : '', onclick: () => { tab = id; render(); } }, label)));
    main.replaceChildren(...(tab === 'agents' ? agentsTab() : tab === 'learned' ? learnedTab() : holdsTab()));
  };

  async function load(force = false) {
    try {
      const res = await fetch(`/api/security?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + tab + (editing ?? '');
      if (!force && sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (!force && active && main.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && ((active as HTMLInputElement).value || editing)) return;
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true);
  timer = setInterval(() => void load(), POLL_MS);
}
