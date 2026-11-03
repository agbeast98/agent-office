import './flows.css';
import { h, openModal, toast } from '../../ui/dom';

// The روال‌ها window: the managers of the teams (a name and a brief, no desk), the scenarios (steps, each given
// to one worker; QA that sends work back; steps done together; steps that wait for the person), and the runs of
// them with how far each has got. Read from, and sent to, the server (see server/http/routes/flows.ts).

interface Person { id: string; name: string; role?: string }
interface Boss { id: string; name: string; team: string; brief: string }
interface Step { title: string; who: string; kind: 'work' | 'qa'; brief: string; together: boolean; gate: boolean; back?: number }
interface Scenario { id: string; name: string; boss: string; steps: Step[]; maxReturns: number }
interface RunStep extends Step { whoName: string; task?: string; taskStatus?: string; done: boolean }
interface Run { id: string; name: string; boss: string; input: string; status: 'running' | 'gate' | 'done' | 'stuck' | 'stopped'; idx: number; returns: number; maxReturns: number; steps: RunStep[]; log: { at: number; text: string }[]; startedAt: number }
interface State { people: Person[]; bosses: Boss[]; scenarios: Scenario[]; runs: Run[] }

const STATUS_FA = { running: 'در حال اجرا', gate: 'منتظر تأیید شما', done: 'تمام شد', stuck: 'گیر کرده', stopped: 'متوقف' } as const;
const TASK_FA: Record<string, string> = { todo: 'در صف', doing: 'در حال انجام', review: 'تحویل شد', done: 'تمام', blocked: 'گیر کرد', cancelled: 'لغو' };
const POLL_MS = 3000;
type Tab = 'runs' | 'scenarios' | 'bosses';

let opened = false;

export function openFlows(floor: string) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { people: [], bosses: [], scenarios: [], runs: [] };
  let tab: Tab = 'runs';
  /** A form that is open: polling leaves the screen alone while it is. */
  let form: { kind: 'boss'; draft: Boss } | { kind: 'scenario'; draft: Scenario } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';

  const nav = h('nav.sec-nav', { role: 'tablist' });
  const main = h('div.sec-main');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.secwin.flowwin', { role: 'dialog', 'aria-label': 'روال‌ها', lang: 'fa', dir: 'rtl' }, h('header', {}, h('h2', {}, '🧭 روال‌ها')), nav, main, msg);
  openModal(el, { doing: 'در بخش روال‌ها', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch(`/api/flows/action?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
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

  const bossName = (id: string) => state.bosses.find((b) => b.id === id)?.name ?? '—';
  const ago = (t: number) => new Date(t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  const field = (label: string, input: HTMLElement) => h('label.sec-field', {}, h('span', {}, label), input);
  const text = (value: string, on: (v: string) => void, ph = '', max = 80) => {
    const i = h('input', { value, placeholder: ph, maxlength: String(max), dir: 'auto' }) as HTMLInputElement;
    i.addEventListener('input', () => on(i.value));
    return i;
  };
  const area = (value: string, on: (v: string) => void, ph = '', rows = 3) => {
    const t = h('textarea', { rows: String(rows), placeholder: ph, dir: 'auto' }) as HTMLTextAreaElement;
    t.value = value;
    t.addEventListener('input', () => on(t.value));
    return t;
  };

  // ---- Runs ----

  const stepStrip = (r: Run) => {
    const [from, to] = groupOf(r.steps, r.idx);
    return h('ol.fl-steps', {}, ...r.steps.map((s, i) => {
      const now = (r.status === 'running' || r.status === 'gate' || r.status === 'stuck') && i >= from && i <= to;
      const cls = s.done && !now ? 'done' : now ? (r.status === 'gate' ? 'gate' : r.status === 'stuck' ? 'stuck' : 'now') : '';
      return h('li', { class: cls }, h('b', {}, `${i + 1}. ${s.title}`), h('small', {}, `${s.whoName}${s.kind === 'qa' ? ' · QA' : ''}${now && s.taskStatus ? ` · ${TASK_FA[s.taskStatus] ?? s.taskStatus}` : ''}`));
    }));
  };

  const runCard = (r: Run) => {
    const live = r.status === 'running' || r.status === 'gate' || r.status === 'stuck';
    return h('div.fl-run', { class: r.status },
      h('div.sec-hh', {}, h('b', {}, r.name), h('span.mr-chip', {}, bossName(r.boss)), h('span.sec-st', { class: r.status }, STATUS_FA[r.status]),
        r.returns ? h('span.mr-chip', {}, `برگشت ${r.returns} از ${r.maxReturns}`) : null, h('small', {}, `${r.id} · ${ago(r.startedAt)}`)),
      r.input ? h('div.sec-note', { dir: 'auto' }, `ورودی: ${r.input}`) : null,
      stepStrip(r),
      h('details.fl-log', {}, h('summary', {}, `گزارش (${r.log.length})`), ...r.log.slice(-25).map((l) => h('div', {}, `${ago(l.at)} — ${l.text}`))),
      h('div.mg-row', {},
        r.status === 'gate' ? h('button.btn.primary', { type: 'button', onclick: () => void call('approve', { id: r.id }) }, '✓ تأیید و ادامه') : null,
        r.status === 'stuck' ? h('button.btn.primary', { type: 'button', onclick: () => void call('retry', { id: r.id }) }, '↻ دوباره امتحان') : null,
        live ? h('button.btn', { type: 'button', onclick: () => confirm('این اجرا متوقف و کارهای بازش لغو شود؟') && void call('stop', { id: r.id }) }, '■ توقف') : h('button.btn', { type: 'button', onclick: () => void call('remove', { id: r.id }) }, 'پاک کردن')));
  };

  const runsTab = () => {
    const pick = h('select', { 'aria-label': 'سناریو' }, ...state.scenarios.map((s) => h('option', { value: s.id }, `${s.name} — ${bossName(s.boss)}`))) as HTMLSelectElement;
    const input = h('textarea', { rows: '2', placeholder: 'ورودی یا موضوع پروژه (مثلاً: مقاله درباره‌ی …)', dir: 'auto' }) as HTMLTextAreaElement;
    const go = h('button.btn.primary', { type: 'button', onclick: async () => { if (pick.value && (await call('start', { id: pick.value, input: input.value }))) { input.value = ''; toast('اجرا شروع شد'); } } }, '▶ شروع');
    return [
      state.scenarios.length
        ? h('div.fl-start', {}, h('b', {}, 'اجرای تازه'), pick, input, go)
        : h('div.mg-empty', {}, 'اول در «سناریوها» یک سناریو بسازید (و پیش از آن در «مدیرها» یک مدیر).'),
      ...(state.runs.length ? state.runs.map(runCard) : [h('div.mg-empty', {}, 'هنوز اجرایی نیست.')]),
    ];
  };

  // ---- Managers ----

  const bossForm = (b: Boss) => h('div.sec-row.fl-form', {},
    field('نام مدیر', text(b.name, (v) => (b.name = v), 'مثلاً مدیر سئو', 60)),
    field('تیم', text(b.team, (v) => (b.team = v), 'سئو', 60)),
    field('دستور مدیر (به هر ایجنت در هر مرحله گفته می‌شود)', area(b.brief, (v) => (b.brief = v), 'لحن، استاندارد کیفیت، چیزهای ممنوع…', 4)),
    h('div.mg-row', {},
      h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('boss', { ...b })) { form = undefined; render(); } } }, 'ذخیره'),
      h('button.btn', { type: 'button', onclick: () => { form = undefined; render(); } }, 'بستن')));

  const bossesTab = () => [
    h('div.mg-empty', {}, 'مدیر تیم میز و صندلی ندارد: دفتر نقش او را بازی می‌کند و هر مرحله را به نفر درست می‌دهد، منتظر می‌ماند و نتیجه را به مرحله‌ی بعد می‌رساند.'),
    form?.kind === 'boss' ? bossForm(form.draft) : h('button.btn.primary', { type: 'button', onclick: () => { form = { kind: 'boss', draft: { id: '', name: '', team: '', brief: '' } }; render(); } }, '＋ مدیر تازه'),
    ...state.bosses.map((b) => h('div.sec-row', {},
      h('div.sec-who', {}, h('b', {}, b.name), h('small', {}, `تیم ${b.team || '—'} · ${state.scenarios.filter((s) => s.boss === b.id).length} سناریو`)),
      h('button.btn', { type: 'button', onclick: () => { form = { kind: 'boss', draft: { ...b } }; render(); } }, '✎ ویرایش'),
      h('button.btn', { type: 'button', onclick: () => confirm(`مدیر «${b.name}» پاک شود؟`) && void call('bossRemove', { id: b.id }) }, 'پاک'))),
  ];

  // ---- Scenarios ----

  const blankStep = (): Step => ({ title: '', who: state.people[0]?.id ?? '', kind: 'work', brief: '', together: false, gate: false });

  const scenarioForm = (sc: Scenario) => {
    const box = h('div.sec-row.fl-form', {});
    const draw = () => {
      const bossSel = h('select', { 'aria-label': 'مدیر' }, h('option', { value: '' }, 'مدیر را انتخاب کنید'), ...state.bosses.map((b) => h('option', { value: b.id }, b.name))) as HTMLSelectElement;
      bossSel.value = sc.boss;
      bossSel.addEventListener('change', () => (sc.boss = bossSel.value));
      const max = h('input', { type: 'number', min: '0', max: '10', value: String(sc.maxReturns) }) as HTMLInputElement;
      max.addEventListener('input', () => (sc.maxReturns = Number(max.value)));
      box.replaceChildren(
        field('نام سناریو', text(sc.name, (v) => (sc.name = v), 'مثلاً تولید مقاله‌ی سئو', 80)),
        field('مدیر', bossSel),
        field('حداکثر برگشت QA (بعد از آن از شما می‌پرسد)', max),
        h('h4', {}, 'مرحله‌ها (به ترتیب)'),
        ...sc.steps.map((s, i) => stepRow(sc, s, i, draw)),
        h('div.mg-row', {},
          h('button.btn', { type: 'button', onclick: () => { sc.steps.push(blankStep()); draw(); } }, '＋ مرحله'),
          h('button.btn.primary', { type: 'button', onclick: async () => { if (await call('scenario', { ...sc })) { form = undefined; render(); toast('سناریو ذخیره شد'); } } }, 'ذخیره'),
          h('button.btn', { type: 'button', onclick: () => { form = undefined; render(); } }, 'بستن')));
    };
    draw();
    return box;
  };

  const stepRow = (sc: Scenario, s: Step, i: number, draw: () => void) => {
    const who = h('select', { 'aria-label': 'مسئول' }, ...state.people.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
    who.value = s.who;
    who.addEventListener('change', () => (s.who = who.value));
    const kind = h('select', { 'aria-label': 'نوع' }, h('option', { value: 'work' }, 'کار'), h('option', { value: 'qa' }, 'QA (تست و بازبینی)')) as HTMLSelectElement;
    kind.value = s.kind;
    kind.disabled = i === 0;
    kind.addEventListener('change', () => { s.kind = kind.value === 'qa' ? 'qa' : 'work'; if (s.kind === 'qa') { s.together = false; s.back ??= i - 1; } draw(); });
    const back = s.kind === 'qa' ? h('select', { 'aria-label': 'برگشت به' }, ...sc.steps.slice(0, i).map((x, k) => h('option', { value: String(k) }, `برگشت به ${k + 1}. ${x.title || '…'}`))) as HTMLSelectElement : undefined;
    if (back) { back.value = String(s.back ?? i - 1); back.addEventListener('change', () => (s.back = Number(back.value))); }
    const check = (label: string, on: boolean, set: (v: boolean) => void, disabled = false) => {
      const c = h('input', { type: 'checkbox', checked: on, disabled }) as HTMLInputElement;
      c.addEventListener('change', () => set(c.checked));
      return h('label.sec-check', {}, c, ` ${label}`);
    };
    const move = (d: number) => { const j = i + d; if (j < 0 || j >= sc.steps.length) return; [sc.steps[i], sc.steps[j]] = [sc.steps[j], sc.steps[i]]; for (const x of sc.steps) if (x.back !== undefined && x.back >= sc.steps.indexOf(x)) x.back = Math.max(0, sc.steps.indexOf(x) - 1); draw(); };
    return h('div.fl-step', { class: s.kind },
      h('div.mg-row', {}, h('b', {}, `${i + 1}`), text(s.title, (v) => (s.title = v), 'عنوان مرحله', 80), who, kind, back ?? null),
      area(s.brief, (v) => (s.brief = v), 'کار این مرحله دقیقاً چیست؟ خروجی چه باشد؟', 2),
      h('div.mg-row', {},
        check('هم‌زمان با مرحله‌ی بعد', s.together, (v) => (s.together = v), s.kind === 'qa' || i === sc.steps.length - 1 || sc.steps[i + 1]?.kind === 'qa'),
        check('پیش از شروع منتظر تأیید من بماند', s.gate, (v) => (s.gate = v)),
        h('button.btn', { type: 'button', onclick: () => move(-1) }, '↑'), h('button.btn', { type: 'button', onclick: () => move(1) }, '↓'),
        h('button.btn', { type: 'button', disabled: sc.steps.length < 2, onclick: () => { sc.steps.splice(i, 1); for (const x of sc.steps) if (x.back !== undefined) x.back = Math.min(x.back, Math.max(0, sc.steps.indexOf(x) - 1)); draw(); } }, 'حذف')));
  };

  const scenariosTab = () => [
    h('div.mg-empty', {}, 'هر سناریو یک روال است: مراحل به ترتیب اجرا می‌شوند، خروجی هر مرحله به بعدی می‌رسد، QA ایرادها را به مرحله‌ی انتخابی برمی‌گرداند. متن آن در پوشه‌ی freelance-team/scenarios.md هم نوشته می‌شود.'),
    form?.kind === 'scenario' ? scenarioForm(form.draft)
      : h('button.btn.primary', { type: 'button', disabled: !state.bosses.length, title: state.bosses.length ? '' : 'اول یک مدیر بسازید', onclick: () => { form = { kind: 'scenario', draft: { id: '', name: '', boss: state.bosses[0]?.id ?? '', maxReturns: 3, steps: [blankStep()] } }; render(); } }, '＋ سناریوی تازه'),
    ...state.scenarios.map((s) => h('div.sec-row', {},
      h('div.sec-who', {}, h('b', {}, s.name), h('small', {}, `${bossName(s.boss)} · ${s.steps.length} مرحله: ${s.steps.map((x) => x.title).join(' ← ')}`)),
      h('button.btn', { type: 'button', onclick: () => { form = { kind: 'scenario', draft: JSON.parse(JSON.stringify(s)) as Scenario }; render(); } }, '✎ ویرایش'),
      h('button.btn', { type: 'button', onclick: () => confirm(`سناریوی «${s.name}» پاک شود؟`) && void call('scenarioRemove', { id: s.id }) }, 'پاک'))),
  ];

  const render = () => {
    const waiting = state.runs.filter((r) => r.status === 'gate' || r.status === 'stuck').length;
    const tabs: [Tab, string][] = [['runs', `▶ اجراها${waiting ? ` (${waiting})` : ''}`], ['scenarios', '📜 سناریوها'], ['bosses', '👔 مدیرها']];
    nav.replaceChildren(...tabs.map(([id, label]) => h('button.mr-tab', { type: 'button', role: 'tab', class: id === tab ? 'on' : '', onclick: () => { tab = id; form = undefined; render(); } }, label)));
    main.replaceChildren(...(tab === 'scenarios' ? scenariosTab() : tab === 'bosses' ? bossesTab() : runsTab()));
  };

  async function load(force = false) {
    try {
      const res = await fetch(`/api/flows?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state) + tab;
      if (!force && (sig === seen || form)) return;
      seen = sig;
      const active = document.activeElement;
      if (!force && active && main.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  }

  void load(true);
  timer = setInterval(() => void load(), POLL_MS);
}

/** The first and last step done together with step `i` (the same rule as the server's). */
function groupOf(steps: { together: boolean }[], i: number): [number, number] {
  let from = i;
  while (from > 0 && steps[from - 1].together) from--;
  let to = from;
  while (to < steps.length - 1 && steps[to].together) to++;
  return [from, to];
}
