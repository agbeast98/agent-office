import { h } from '../../ui/dom';
import { ENGINES, type Call, type Person, type Proposal, type State, type TeamView } from './hiring-types';

// The تیم‌ها tab of the استخدام window: each team with its manager and members, what its manager proposes, the
// thread in which the person asks the manager whether the team is enough, and those who work alone.

const QUICK = 'نیروهایی که الان داریم برای این کار کافی‌اند؟ واقع‌گرایانه بگو: اگر کم است چه چیزی و چرا، و اگر کافی است صریح بگو کافی است.';
const ago = (t: number) => new Date(t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const post = (p: Person) => (p.role ?? '').split(':')[0].trim() || 'بدون سمت';

/** Answers a typed advice message wasn't sent yet, per team, so a redraw doesn't lose them. */
const drafts = new Map<string, string>();

export function teamsTab(state: State, call: Call, useProposal: (p: Proposal) => void): HTMLElement[] {
  const engineOf = (p: Person) => ENGINES.find(([v]) => v === (p.provider ?? 'claude'))?.[1] ?? p.provider ?? 'Claude';
  const person = (p: Person, boss = false) => {
    const sel = h('select', { 'aria-label': 'موتور', title: 'همین آدم با موتور دیگر؛ پروفایل و جایش در تیم می‌ماند' }, ...ENGINES.filter(([v]) => v && v !== (p.provider ?? 'claude')).map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    return h('div.hr-person', { class: p.interview ? 'talk' : '' },
      h('b', {}, p.name), h('small', {}, `${boss ? '🧭 مدیر · ' : ''}${post(p)}${p.interview ? ' · در مصاحبه' : ''} · ${engineOf(p)}`),
      p.interview ? null : h('div.mg-row', {}, sel, h('button.btn', { type: 'button', onclick: () => confirm(`${p.name} با ${sel.selectedOptions[0]?.textContent ?? ''} دوباره راه‌اندازی شود؟ پروفایل و جایش در تیم می‌ماند.`) && void call('switch', { worker: p.id, provider: sel.value }) }, '🔁 تغییر موتور')));
  };

  const proposalCard = (p: Proposal) => h('div.hr-prop', {},
    h('div.sec-hh', {}, h('b', {}, p.kind === 'hire' ? `پیشنهاد استخدام: ${p.role}` : `پیشنهاد عضو شدن: ${p.workerName ?? '؟'}`), h('small', {}, `از ${p.by} · ${ago(p.at)}`)),
    h('p', { dir: 'auto' }, p.why),
    p.skill ? h('details', {}, h('summary', {}, 'پیش‌نویس مهارت'), h('pre', { dir: 'auto' }, p.skill)) : null,
    h('div.mg-row', {},
      p.kind === 'hire'
        ? h('button.btn.primary', { type: 'button', onclick: () => useProposal(p) }, '✓ استخدام با این مشخصات')
        : h('button.btn.primary', { type: 'button', onclick: () => void call('proposal', { id: p.id, verdict: 'accepted' }) }, '✓ بپذیر'),
      h('button.btn', { type: 'button', onclick: () => void call('proposal', { id: p.id, verdict: 'dismissed' }) }, '✕ لازم نیست')));

  const advice = (t: TeamView) => {
    const list = h('div.hr-chat', { role: 'log' }, ...(t.advice.length ? t.advice.map((a) => h('div.hr-msg', { class: a.by === 'boss' ? 'boss' : 'manager' }, h('b', {}, a.by === 'boss' ? 'شما' : `🧭 ${t.manager?.name ?? 'مدیر'}`), h('div', { dir: 'auto' }, a.text))) : [h('div.mg-empty', {}, 'بپرسید نیروهای فعلی کافی‌اند یا چه کم است؛ مدیر صریح جواب می‌دهد و اگر لازم باشد نیرو پیشنهاد می‌کند.')]));
    list.scrollTop = list.scrollHeight;
    const input = h('textarea', { rows: '2', placeholder: 'از مدیر بپرسید: مثلاً «برای تولید محتوای سئو چه نیروهایی لازم داریم؟»', dir: 'auto', maxlength: '2000' }) as HTMLTextAreaElement;
    input.value = drafts.get(t.id) ?? '';
    input.addEventListener('input', () => drafts.set(t.id, input.value));
    const send = async (text: string) => { if (!text.trim()) return; if (await call('advise', { team: t.id, text })) { drafts.delete(t.id); input.value = ''; } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input.value); } });
    const waiting = t.advice.length > 0 && t.advice[t.advice.length - 1].by === 'boss';
    return h('div.hr-advice', {},
      h('h4', {}, '💬 مشاوره با مدیر'),
      list,
      waiting ? h('div.hr-status', {}, `⏳ منتظر نظر ${t.manager?.name ?? 'مدیر'}…`) : null,
      h('div.hr-reply', {}, input, h('button.btn.primary', { type: 'button', onclick: () => void send(input.value) }, 'ارسال')),
      h('button.btn', { type: 'button', onclick: () => void send(QUICK) }, '🔍 نیروهای فعلی کافی‌اند؟'));
  };

  const teamCard = (t: TeamView) => h('section.hr-card.team', {},
    h('div.sec-hh', {}, h('h3', {}, `👥 تیم ${t.name}`), h('small', {}, `${t.members.length + (t.manager ? 1 : 0)} نفر`)),
    t.manager ? person(t.manager, true) : h('div.hr-warn', {}, 'این تیم مدیر ندارد (مدیرش رفته است).'),
    t.manager?.interview ? h('div.hr-warn', {}, 'مصاحبه‌ی مدیر هنوز تمام نشده: بعد از استخدامش می‌توانید با او مشورت کنید و نیرو اضافه کنید.') : null,
    ...(t.members.length ? t.members.map((m) => h('div.hr-member', {}, person(m), h('button.btn', { type: 'button', title: 'از تیم برداشته شود (مستقل می‌شود)', onclick: () => confirm(`${m.name} از تیم برداشته شود؟`) && void call('leave', { worker: m.id }) }, 'برداشتن'))) : [h('div.mg-empty', {}, 'هنوز عضوی نیست.')]),
    t.proposals.length ? h('div.hr-sec', {}, h('h4', {}, `🧭 پیشنهادهای مدیر (${t.proposals.length})`), ...t.proposals.map(proposalCard)) : null,
    t.manager && !t.manager.interview ? advice(t) : null);

  const alone = state.alone.filter((p) => !p.interview);
  return [
    ...(state.teams.length ? state.teams.map(teamCard) : [h('div.hr-card', {}, h('h3', {}, 'هنوز تیمی نیست'), h('div.mg-empty', {}, 'برای ساختن تیم، در تب «استخدام» اولین نفر را به‌عنوان «مدیر یک تیم تازه» استخدام کنید؛ بعد نیروها را با مشورت او اضافه می‌کنید.'))]),
    h('section.hr-card', {}, h('h3', {}, '🧍 مستقل (برای خودشان کار می‌کنند)'),
      ...(alone.length ? alone.map((p) => {
        const sel = h('select', { 'aria-label': 'تیم' }, ...state.teams.map((t) => h('option', { value: t.id }, `تیم ${t.name}`))) as HTMLSelectElement;
        return h('div.hr-member', {}, person(p), state.teams.length ? h('div.mg-row', {}, sel, h('button.btn', { type: 'button', onclick: () => void call('adopt', { team: sel.value, worker: p.id }) }, 'افزودن به تیم')) : null);
      }) : [h('div.mg-empty', {}, 'همه در تیم‌اند یا ایجنتی نیست.')])),
  ];
}
