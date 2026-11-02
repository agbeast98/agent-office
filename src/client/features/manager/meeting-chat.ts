import { h, toast } from '../../ui/dom';
import { CHAIRS, CHOICE_FA, MODE_FA, clock, doing, type Act, type Full, type Person, type State } from './meeting-model';

// The meeting room's conversation and its people: who said what in each round (with who is typing, who has
// spoken and who is still to), the box to say something to everyone or ask one person, and the people at the
// table with a button each to ask them something or let them go.

const initial = (name: string) => [...name.trim()][0] ?? '؟';
const byId = (state: State, id?: string) => state.people.find((p) => p.id === id);

function avatar(name: string, color?: string, boss = false) {
  return h('span.mr-av', { class: boss ? 'boss' : '', style: color && !boss ? `background:${color}` : '' }, boss ? '👑' : initial(name));
}

/** Everything said, by round. */
export function feed(m: Full, state: State) {
  const said = m.said.filter((s) => !s.note);
  const rounds = [...new Set(said.map((s) => s.round))].sort((a, b) => a - b);
  if (!rounds.length) return h('div.mr-empty', {}, h('b', {}, '🕐 هنوز کسی چیزی نگفته'), 'پیام جلسه به همه‌ی حاضران رسیده است؛ نظرها همین‌جا ظاهر می‌شود.');
  return h('div.mr-feed', {}, ...rounds.flatMap((r) => [
    h('div.mr-round', {}, h('span', {}, `دور ${r}`)),
    ...said.filter((s) => s.round === r).map((s) => {
      const who = byId(state, s.id);
      const you = !s.id;
      return h('div.mr-msg', { class: `${you ? 'you' : ''} ${s.to ? 'ask' : ''}` }, avatar(s.by, who?.color, you),
        h('div.mr-bub', {}, h('div.mr-who', {}, h('b', {}, s.by), s.to ? h('span.mr-to', {}, `← ${s.to.name}`) : null, !you && who?.role ? h('small', {}, who.role.split(':')[0]) : null, h('time', {}, clock(s.at))),
          h('div.mr-text', { dir: 'auto' }, s.text)));
    }),
  ]));
}

/** How this meeting goes, and for a debate or a vote where it has got to. */
export function modeBar(m: Full, act: Act) {
  if (m.mode === 'poll') return null;
  if (m.mode === 'debate') {
    const state = m.concluded ? '✅ بحث تمام شد؛ از مدیر جمع‌بندی خواسته شد' : `دور ${m.round} از ${m.rounds} · دورها خودکار می‌گذرد، وقتی همه جواب هم را دادند`;
    return h('div.mr-mode', {}, h('b', {}, '🗣 بحث بین خودشان'), h('span', {}, state));
  }
  const r = m.result;
  const total = Math.max(1, m.members.length);
  const bar = (c: 'yes' | 'no' | 'abstain') => {
    const n = m.votes.filter((v) => v.choice === c).length;
    return h('div.mr-bar', { class: c }, h('span', {}, `${CHOICE_FA[c]} ${n}`), h('i', { style: `width:${Math.round((n / total) * 100)}%` }));
  };
  const verdict = r ? { accepted: '✅ تصویب شد', rejected: '❌ رد شد', tie: '⚖️ مساوی شد' }[r.verdict] : `${m.votes.length} از ${m.members.length} رأی داده‌اند`;
  return h('div.mr-mode.vote', {}, h('div.mr-vhead', {}, h('b', {}, '🗳 رأی‌گیری'), h('span.mr-verdict', { class: r?.verdict ?? '' }, verdict),
    r ? null : h('button.btn', { type: 'button', disabled: !m.votes.length, title: 'رأی‌های داده‌شده همین حالا شمرده شود', onclick: () => void act('closevote') }, 'شمارش همین حالا')),
  bar('yes'), bar('no'), bar('abstain'),
  ...m.votes.map((v) => h('div.mr-vote', { class: v.choice, dir: 'auto' }, h('b', {}, v.name), h('span', {}, CHOICE_FA[v.choice]), v.reason ? h('small', {}, v.reason) : null)));
}

/** Who has spoken this round and who is still to, live. */
export function roundStrip(m: Full, state: State) {
  return h('div.mr-strip', {}, h('span.mr-rd', {}, `${MODE_FA[m.mode]} · دور ${m.round}${m.mode === 'debate' ? ` از ${m.rounds}` : ''}`), ...m.members.map((x) => {
    const spoke = m.mode === 'vote' ? m.votes.some((v) => v.id === x.id) : m.said.some((s) => s.id === x.id && s.round === m.round && !s.note);
    const d = doing(byId(state, x.id), spoke);
    return h('span.mr-chip', { class: d.cls, title: byId(state, x.id)?.activity ?? '' }, h('i'), x.name, h('small', {}, d.text));
  }));
}

/** The box to say something to everyone or ask one person, kept between refreshes so a half-typed line isn't lost. */
export function composer(act: Act) {
  const to = h('select', { 'aria-label': 'به چه کسی' }) as HTMLSelectElement;
  const input = h('input', { placeholder: 'پیام شما…', maxlength: '3000', dir: 'auto', 'aria-label': 'پیام' }) as HTMLInputElement;
  const send = async () => {
    if (!input.value.trim()) return;
    const ok = to.value === 'all' ? await act('say', { text: input.value }) : await act('ask', { to: to.value, text: input.value });
    if (ok) input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
  const btn = h('button.btn.primary', { type: 'button', onclick: () => void send() }, 'ارسال');
  const el = h('div.mr-dock', {}, to, input, btn);
  return {
    el,
    /** Keeps the list of who to say it to current, with what was picked still picked. */
    sync(m: Full) {
      const keep = to.value;
      to.replaceChildren(h('option', { value: 'all' }, '👥 همه‌ی حاضران'), ...m.members.map((x) => h('option', { value: x.id }, `❓ ${x.name}`)));
      to.value = [...to.options].some((o) => o.value === keep) ? keep : 'all';
    },
    askOne(id: string) {
      to.value = id;
      input.focus();
    },
  };
}

/** The people at the table, and those who could be asked in. */
export function people(m: Full, state: State, act: Act, askOne: (id: string) => void) {
  const full = m.members.length >= CHAIRS;
  const card = (p: Person) => {
    const mine = m.members.some((x) => x.id === p.id);
    const spoke = m.said.some((s) => s.id === p.id && s.round === m.round && !s.note);
    const last = [...m.said].reverse().find((s) => s.id === p.id && !s.note);
    const d = doing(p, spoke);
    return h('div.mr-person', { class: `${mine ? '' : 'out'} ${p.id === state.manager ? 'boss' : ''}` },
      h('div.mr-ph', {}, avatar(p.name, p.color, p.id === state.manager), h('div', {}, h('b', {}, p.name), p.role ? h('small', {}, p.role.split(':')[0]) : null), mine ? h('span.mr-chip', { class: d.cls }, h('i'), d.text) : h('span.mr-chip.off', {}, 'بیرون از جلسه')),
      mine ? h('div.mr-seat', { class: p.seated ? 'ok' : 'no' }, p.seated ? '🪑 سر میز جلسه نشسته' : '⚠ هنوز سر میز نیامده', p.seated ? null : h('button.btn', { type: 'button', onclick: async () => { if (await act('seat', { worker: p.id })) toast(`${p.name} سر میز نشست`); } }, '🪑 بنشان')) : null,
      mine ? h('div.mr-last', { dir: 'auto' }, last ? `«${last.text.slice(0, 180)}${last.text.length > 180 ? '…' : ''}»` : 'هنوز چیزی نگفته') : null,
      h('div.mg-row', {}, ...(mine
        ? [h('button.btn', { type: 'button', onclick: () => askOne(p.id) }, '❓ پرسش'), h('button.btn', { type: 'button', title: 'از جلسه مرخص و به میزش برگردد', onclick: () => void act('dismiss', { worker: p.id }) }, '↩ مرخص')]
        : [h('button.btn', { type: 'button', disabled: full, title: full ? `میز ${CHAIRS} صندلی دارد` : 'به میز جلسه دعوت شود', onclick: async () => { if (await act('invite', { worker: p.id })) toast(`${p.name} دعوت شد`); } }, '＋ دعوت')])));
  };
  return h('div.mr-people', {}, ...[...state.people].sort((a, b) => Number(b.inMeeting) - Number(a.inMeeting)).map(card));
}
