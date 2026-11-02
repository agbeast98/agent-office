import './meeting.css';
import { MEETING_PATTERNS, MEETING_PATTERN_IDS, meetingSpend, outputProblem, slugify } from '../../shared/meetings';
import { fmtTokens, type Meeting, type MeetingPattern, type MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { confirmDialog } from './prompt';
import { providerPicker } from './provider';
import { officePrompt } from './prompts';
import { issueVars } from './github/prompts';
import { dictateField } from './dictate';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
}

/** A meeting about a GitHub issue: the form filled in with it. */
export function issueMeeting(n: number, title: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: officePrompt('issue.meeting', issueVars({ number: n, title })) };
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: '⏳ نوبت بعد', sent: '📨 واگذار شد', working: '💬 در حال انجام', done: '✅ نوشته شد' };

const PATTERN_FA: Record<MeetingPattern, { label: string; blurb: string }> = {
  debate: { label: 'گفت‌وگوی چالشی', blurb: 'هر عضو پیشنهادش را مطرح می‌کند و پیشنهادهای دیگران را نقد می‌کند؛ در دور پایانی، راهبر نتیجه را می‌نویسد.' },
  lead: { label: 'راهبر و تیم', blurb: 'راهبر کار را تقسیم می‌کند، اعضا بخش‌هایشان را انجام می‌دهند و راهبر نتیجه را یکپارچه می‌کند.' },
  mapreduce: { label: 'تقسیم و جمع‌بندی', blurb: 'اعضا هم‌زمان روی بخش‌های جداگانه کار می‌کنند و راهبر نتیجه‌ها را کنار هم می‌گذارد.' },
  redblue: { label: 'حمله و دفاع', blurb: 'گروه قرمز ایرادها و خطرها را پیدا می‌کند؛ گروه آبی آن‌ها را برطرف می‌کند تا چیزی باقی نماند.' },
  review: { label: 'گروه بازبینی', blurb: 'هر بازبین تغییرات را از دید تخصصی خودش بررسی می‌کند و راهبر یک بازبینی نهایی می‌نویسد.' },
};
const ROLE_FA: Record<string, string> = {
  Chair: 'راهبر جلسه', Pragmatist: 'عمل‌گرا', Skeptic: 'منتقد', Simplifier: 'ساده‌ساز', 'User advocate': 'نمایندهٔ کاربر',
  Lead: 'راهبر', Engineer: 'مهندس', Reducer: 'جمع‌بندی‌کننده', Mapper: 'بررسی‌کنندهٔ بخش', 'Blue team': 'گروه آبی',
  'Red team': 'گروه قرمز', Correctness: 'درستی', Security: 'امنیت', 'Performance & simplicity': 'کارایی و سادگی', Tests: 'آزمون‌ها', 'API design': 'طراحی رابط برنامه‌نویسی',
};
const faDigits = (value: number | string) => String(value).replace(/\d/g, (n) => '۰۱۲۳۴۵۶۷۸۹'[Number(n)]);
const roleFa = (role: string) => ROLE_FA[role] ?? role;
const doingFa = (doing: string) => ({
  'writing the decision': 'نوشتن تصمیم نهایی', proposing: 'ارائهٔ پیشنهاد', critiquing: 'نقد پیشنهادها', planning: 'برنامه‌ریزی',
  'doing their part': 'انجام بخش واگذارشده', 'merging the work': 'یکپارچه‌کردن کارها', mapping: 'بررسی بخش', reducing: 'جمع‌بندی نتیجه‌ها',
  attacking: 'پیداکردن ایرادها', 'writing it up': 'نوشتن نتیجه', fixing: 'رفع ایرادها', 'fixing and writing it up': 'رفع ایرادها و نوشتن نتیجه',
  reviewing: 'بازبینی', 'writing the review': 'نوشتن بازبینی نهایی',
} as Record<string, string>)[doing] ?? doing;
const meetingStageFa = (m: Meeting) => {
  const doing = [...new Set(m.turns.filter((t) => t.state !== 'done').map((t) => doingFa(t.doing)))].join('، ');
  return `دور ${faDigits(m.round)} از ${faDigits(m.rounds)}${doing ? ` · ${doing}` : ''}`;
};
const statusFa = (status: string) => ({ starting: 'در حال شروع', ready: 'آماده', working: 'در حال کار', 'needs input': 'منتظر پاسخ', done: 'تمام‌شده', exited: 'خارج‌شده', asleep: 'آفلاین' } as Record<string, string>)[status] ?? status;
const timeAgoFa = (date: string) => timeAgo(date).replace('just now', 'همین حالا').replace(/(\d+)m ago/, (_, n: string) => `${faDigits(n)} دقیقه پیش`).replace(/(\d+)h ago/, (_, n: string) => `${faDigits(n)} ساعت پیش`).replace(/(\d+)d ago/, (_, n: string) => `${faDigits(n)} روز پیش`);
const summaryFa = (summary: string) => summary
  .replaceAll('Debate', 'گفت‌وگوی چالشی').replaceAll('Lead & team', 'راهبر و تیم').replaceAll('Map-reduce', 'تقسیم و جمع‌بندی')
  .replaceAll('Red / blue', 'حمله و دفاع').replaceAll('Review panel', 'گروه بازبینی')
  .replace(/(\d+) rounds?/g, (_, n: string) => `${faDigits(n)} دور`).replace(/round (\d+) of (\d+)/g, (_, a: string, b: string) => `دور ${faDigits(a)} از ${faDigits(b)}`)
  .replaceAll(' tokens', ' توکن').replaceAll(' · posted on the PR', ' · روی درخواست ادغام ثبت شد').replaceAll(' · stopped', ' · متوقف‌شده');

/**
 * The meeting room's window. With a meeting at the table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  const close = h('button.btn.close', { 'aria-label': 'بستن' }, '✕');
  const title = h('h2', {}, '🤝 اتاق جلسه');
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.meeting-window', { role: 'dialog', 'aria-label': 'اتاق جلسه', lang: 'fa', dir: 'rtl' }, h('header', {}, title, close), body, foot);
  let view: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const render = () => {
    if (view === 'status' && store.meeting.current) {
      form = null;
      title.textContent = '🤝 اتاق جلسه';
      renderStatus(store.meeting.current, body, foot, net, actions, () => {
        view = 'form';
        render();
      });
      return;
    }
    if (!form) {
      form = meetingForm(net, preset, () => modal.close(), () => {
        view = 'status';
        render();
      });
      title.textContent = '🤝 برگزاری جلسه';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, { doing: '🤝 at the meeting room', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'در جلسه' : m.status === 'done' ? 'پایان‌یافته' : 'متوقف‌شده');
  const seats = h(
    'ul.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${doingFa(t.doing)}` : '👂 در حال گوش‌دادن') : '';
      return h(
        'li',
        {},
        h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
        h('b', {}, roleFa(s.role)),
        h('span.muted', {}, `${i === 0 ? 'راهبر جلسه · ' : ''}${s.workerName ?? '…'}`),
        w ? h('span.pill', { class: w.status }, statusFa(STATUS_LABEL[w.status])) : h('span.pill.exited', {}, 'به میز خود برگشته'),
        part ? h('span.meeting-part', { title: t?.file ?? '' }, part) : null,
        s.tokens ? h('span.muted', {}, `${fmtTokens(s.tokens)} توکن`) : null,
        w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ ترمینال') : null,
      );
    }),
  );
  const where = m.worktree ? h('span', {}, '🌿 ', h('code', {}, m.worktree.branch), m.commit ? ` · ثبت ${m.commit}` : '') : null;
  const review = m.review?.url ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `🔍 بازبینی درخواست ادغام #${m.pr} ↗`) : m.review?.error ? h('span.bad', {}, `ارسال بازبینی ناموفق بود: ${m.review.error}`) : null;
  body.replaceChildren(
    ...present(
    h('div.meeting-head', {}, pill, h('b', {}, `${p.icon} ${PATTERN_FA[m.pattern].label}`), h('span.meeting-title', { title: m.prompt }, m.title)),
    h('p.meeting-line', {}, running ? `${meetingStageFa(m)} · به‌دعوت ${m.calledBy} · ${timeAgoFa(new Date(m.startedAt).toISOString())}` : m.status === 'done' ? `✅ فایل ${m.output} در ${faDigits(m.round)} دور نوشته شد` : `⛔ جلسه در دور ${faDigits(m.round)} متوقف شد: ${m.reason ?? 'توقف جلسه'}`),
    m.tokens ? h('p.meeting-spend', { title: `${faDigits(m.tokens.toLocaleString())} توکن، با احتساب خواندن حافظه` }, `💸 ${meetingSpend(m).replace(' tokens', ' توکن')}${running ? ' تا این لحظه' : ''}`) : null,
    seats,
    h('div.meeting-out', {}, h('div.meeting-out-head', {}, h('b', {}, '📄 '), h('code', {}, m.output), where, review), h('pre.meeting-preview', { dir: 'auto' }, m.preview?.trim() ? m.preview : running ? 'هنوز چیزی نوشته نشده است.' : 'در این جلسه فایلی نوشته نشد.')),
    store.meeting.past.length
      ? h('details.meeting-past', {}, h('summary', {}, `جلسه‌های قبلی (${faDigits(store.meeting.past.length)})`), h('ul', {}, ...store.meeting.past.map((r) => h('li', { title: `به‌دعوت ${r.calledBy}` }, h('b', {}, r.title), h('div.muted', { dir: 'auto' }, summaryFa(r.summary))))))
      : null,
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
    h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
    h('span.grow', {}, running ? 'اعضا پس از پایان جلسه هم کنار میز می‌مانند تا بتوانید ترمینالشان را ببینید.' : 'با خالی‌کردن اتاق، اعضا به میزهایشان برمی‌گردند. فایل ثبت‌شده روی شاخه باقی می‌ماند.'),
    running ? h('button.btn', { type: 'button', onclick: () => confirmDialog('جلسه متوقف شود؟', `اعضا همین‌جا می‌مانند و جلسه را ترک نمی‌کنند. فایل ${m.output} فقط در صورتی وجود دارد که تا اینجا نوشته شده باشد.`, 'توقف جلسه', () => net.send({ t: 'meeting.stop' })) }, '⛔ توقف جلسه') : null,
    !running && m.commit && head?.worktree ? h('button.btn', { type: 'button', title: `ارسال ${m.worktree?.branch} و ساخت درخواست ادغام`, onclick: () => actions.openPr(head.id) }, head.pr ? `🔀 درخواست ادغام #${head.pr.number}` : '🔀 ساخت درخواست ادغام') : null,
    !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, '🧹 خالی‌کردن اتاق') : null,
    !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 برگزاری جلسهٔ دیگر…') : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the round limit. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, done: () => void, back: () => void) {
  let pattern: MeetingPattern = preset?.pattern ?? 'debate';
  let roles: string[] = [];
  let outputTouched = false;
  const patterns = h('div.meeting-patterns', { role: 'radiogroup', 'aria-label': 'روش برگزاری جلسه' });
  const about = h('textarea', { rows: 4, placeholder: 'پرسشی که باید به نتیجه برسد یا کاری که باید انجام شود…', 'aria-label': 'موضوع جلسه', dir: 'auto' }) as HTMLTextAreaElement;
  about.value = preset?.prompt ?? '';
  const titleIn = h('input', { type: 'text', placeholder: 'عنوان جلسه (اختیاری؛ در غیر این صورت خط اول موضوع)', maxlength: 100, 'aria-label': 'عنوان جلسه', dir: 'auto' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input', { type: 'text', 'aria-label': 'مسیر فایل خروجی', spellcheck: 'false', dir: 'ltr' }) as HTMLInputElement;
  const outputNote = h('small.muted');
  const prSel = h('select.provider-select', { 'aria-label': 'درخواست ادغام' }) as HTMLSelectElement;
  const prRow = h('div.meeting-field', {}, h('label', {}, 'درخواست ادغام'), prSel);
  const partsIn = h('textarea', { rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'بخش‌ها', spellcheck: 'false', dir: 'ltr' }) as HTMLTextAreaElement;
  const partsRow = h('div.meeting-field', {}, h('label', {}, 'بخش‌ها (هرکدام در یک خط)'), partsIn, h('small.muted', {}, 'فایل‌ها، پوشه‌ها، ماژول‌ها یا مسئله‌ها به‌ترتیب میان اعضای اجراکننده تقسیم می‌شوند.'));
  const count = h('b');
  const minus = h('button.btn.small', { type: 'button', 'aria-label': 'یک عضو کمتر' }, '−');
  const plus = h('button.btn.small', { type: 'button', 'aria-label': 'یک عضو بیشتر' }, '+');
  const roleList = h('div.meeting-roles');
  const roundsSel = h('select.provider-select.meeting-rounds', { 'aria-label': 'تعداد دورها' }) as HTMLSelectElement;
  // A pattern that always runs the same rounds says so, where a locked control would look broken.
  const roundsFixed = h('span.meeting-fixed');
  const roundsNote = h('small.muted');
  const provider = providerPicker(store.project, 'meeting-provider', 'ایجنت‌های جلسه', 'fa');
  const busy = h('p.meeting-busy');
  const submit = h('button.btn.primary', { type: 'submit' }, '🤝 شروع جلسه');
  const cancel = h('button.btn', { type: 'button', onclick: store.meeting.current ? back : done }, store.meeting.current ? '← بازگشت' : 'لغو');
  const aboutEntry = dictateField(about);
  const microphone = aboutEntry.querySelector('button');
  if (microphone) {
    microphone.setAttribute('aria-label', 'نوشتن موضوع با گفتار');
    microphone.title = 'برای نوشتن موضوع جلسه با صدا کلیک کنید';
  }

  const def = () => MEETING_PATTERNS[pattern];
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    const problemFa = problem ? (({ 'Say which file the meeting writes': 'مسیر فایل خروجی را وارد کنید', 'That output path is too long': 'مسیر فایل خروجی بیش از حد طولانی است', 'The output file goes inside the project: give a path relative to it': 'مسیر را نسبت به پوشهٔ پروژه وارد کنید', 'The output path has control characters in it': 'مسیر فایل نویسهٔ نامعتبر دارد' } as Record<string, string>)[problem] ?? problem) : undefined;
    outputNote.textContent = problemFa ? `⚠️ ${problemFa}` : pattern === 'review' ? 'پس از نوشتن این فایل، بازبینی به‌صورت یک نظر روی درخواست ادغام ثبت می‌شود.' : store.project?.branch ? 'با نوشتن این فایل، جلسه پایان می‌یابد و آن را روی شاخهٔ مخصوص جلسه ثبت می‌کند.' : 'با نوشتن این فایل، جلسه پایان می‌یابد.';
    outputNote.classList.toggle('bad', !!problem);
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = faDigits(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= d.seats.max);
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input', { type: 'text', value: roleFa(r), maxlength: 40, 'aria-label': `نقش ${faDigits(i + 1)}`, dir: 'auto' }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        return h('div.meeting-role', {}, h('span.muted', {}, i === 0 ? '👑' : `${i + 1}`), input);
      }),
    );
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = d.roles.slice(0, d.seats.default);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    const fixed = d.rounds.min === d.rounds.max;
    const limits = Array.from({ length: d.rounds.max - d.rounds.min + 1 }, (_, i) => d.rounds.min + i);
    roundsSel.replaceChildren(...limits.map((n) => h('option', { value: String(n) }, `${faDigits(n)} دور`)));
    roundsSel.value = String(d.rounds.default);
    roundsSel.classList.toggle('hidden', !!fixed);
    roundsFixed.classList.toggle('hidden', !fixed);
    const stageFa = (s: string) => ({ Planning: 'برنامه‌ریزی', Execution: 'اجرا', Merge: 'یکپارچه‌سازی', Map: 'بررسی بخش‌ها', Reduce: 'جمع‌بندی', Reviews: 'بازبینی‌ها', 'Combined review': 'بازبینی نهایی' } as Record<string, string>)[s] ?? s;
    roundsFixed.textContent = fixed ? `🔒 ${faDigits(d.rounds.max)} دور · روش «${PATTERN_FA[pattern].label}»` : '';
    roundsFixed.title = fixed ? `این روش همیشه ${faDigits(d.rounds.max)} دور دارد${d.stages?.length ? `: ${d.stages.map(stageFa).join(' ← ')}` : ''}. تعداد دورها بخشی از روند آن است.` : '';
    roundsNote.textContent = fixed ? (d.stages ?? []).map(stageFa).join(' ← ') : `${faDigits(d.rounds.min)} تا ${faDigits(d.rounds.max)} دور. ${d.roundsNote ? ({ 'Proposals, then a round of critique per extra round, then the decision.': 'ابتدا پیشنهادها، سپس در هر دور نقد و در پایان تصمیم نهایی.', 'An attack and a fix per round; it ends early when red finds nothing more.': 'در هر دور یک حمله و یک رفع ایراد؛ اگر گروه قرمز مورد دیگری پیدا نکند، جلسه زودتر تمام می‌شود.' } as Record<string, string>)[d.roundsNote] ?? d.roundsNote : ''}`.trim();
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.meeting-pattern', { type: 'button', role: 'radio', 'data-pattern': id, onclick: () => pickPattern(id) }, h('b', {}, `${d.icon} ${PATTERN_FA[id].label}`), h('small', {}, PATTERN_FA[id].blurb)));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) roles.pop();
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < def().seats.max) roles.push(def().roles[roles.length] ?? `Worker ${roles.length + 1}`);
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);

  const bodyEl = h(
    'form.meeting-form',
    {},
    patterns,
    h('div.meeting-field', {}, h('label', {}, 'موضوع جلسه چیست؟'), aboutEntry),
    h('div.meeting-field', {}, titleIn),
    prRow,
    partsRow,
    h('div.meeting-field', {}, h('label', {}, 'مسیر فایل خروجی'), outputIn, outputNote),
    h('div.meeting-field', {}, h('label.meeting-count', {}, 'اعضای حاضر در جلسه', minus, count, plus), roleList),
    h('div.meeting-field', {}, h('label', {}, 'تعداد دورها'), roundsSel, roundsFixed, roundsNote),
    provider.element,
    busy,
  ) as HTMLFormElement;
  bodyEl.noValidate = true;

  const send = () => {
    if (store.meeting.current?.status === 'running') return;
    const prompt = about.value.trim();
    if (!prompt) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`دست‌کم ${faDigits(roles.length - 1)} بخش را هرکدام در یک خط وارد کنید یا تعداد اعضا را کم کنید.`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (outputProblem(output)) return outputIn.focus();
    if (!provider.valid()) return;
    net.send({
      t: 'meeting.start',
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      output,
      roles: roles.map((r) => r.trim()),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsSel.value) || undefined,
      provider: provider.value(),
      model: provider.model(),
      effort: provider.effort(),
    });
    toast(`🤝 جلسهٔ «${PATTERN_FA[pattern].label}» شروع شد؛ اعضا به اتاق جلسه می‌روند.`);
    done();
  };
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const want = prSel.value || (preset?.pr ? String(preset.pr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (preset?.pr && !open.some((p) => p.number === preset.pr)) opts.unshift([String(preset.pr), `#${preset.pr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(h('option', { value: '' }, open.length || preset?.pr ? 'انتخاب درخواست ادغام…' : 'درخواست ادغام بازی وجود ندارد'), ...opts.map(([v, label]) => h('option', { value: v, dir: 'auto' }, label.length > 70 ? `${label.slice(0, 69)}…` : label)));
      prSel.value = want;
      syncOutput();
    }
    const m = store.meeting.current;
    const taken = m?.status === 'running';
    busy.textContent = taken ? `اتاق تا پایان یا توقف «${m.title}» در اختیار این جلسه است.` : m ? 'با شروع جلسهٔ جدید، اعضای جلسهٔ قبلی به میزهایشان برمی‌گردند.' : '';
    submit.toggleAttribute('disabled', taken);
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, foot: [h('span.grow', {}, 'تعداد دور کمتر و یک فایل خروجی، هزینهٔ جلسه را پایین نگه می‌دارد.'), cancel, submit], refresh };
}
