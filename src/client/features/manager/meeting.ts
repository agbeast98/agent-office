import { h, openModal, toast } from '../../ui/dom';

// The team meeting: you name a subject and who is to come (the people the team already has, no one is
// hired), they sit down at the meeting room's table and each says their piece, round after round. You can
// speak too, hand them the next round, ask the manager to write it up, and end it. Read from, and sent to,
// the server every couple of seconds (see server/http/routes/team.ts).

interface Said { at: number; round: number; by: string; id?: string; text: string }
interface Meeting { id: string; topic: string; calledBy: string; round: number; members: { id: string; name: string }[]; said: Said[]; summary?: string }
interface Past { id: string; topic: string; startedAt: number; summary?: string; said: number }
interface State { current?: Meeting; past: Past[] }

const POLL_MS = 2000;
let opened = false;

export function openTeamMeeting(floor: string, people: { id: string; name: string }[]) {
  if (opened) return;
  opened = true;
  const qs = new URLSearchParams({ floor }).toString();
  let state: State = { past: [] };
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = '';

  const body = h('div.mt-body');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.manager-window.mt-window', { role: 'dialog', 'aria-label': 'جلسه‌ی تیمی', lang: 'fa', dir: 'rtl' }, h('header', {}, h('h2', {}, '🤝 جلسه‌ی تیمی')), body, msg);
  openModal(el, { doing: 'در جلسه‌ی تیمی', onClose: () => { opened = false; if (timer) clearInterval(timer); } });

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch(`/api/team/meeting?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      seen = '';
      await load();
      return true;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return false;
    }
  };

  const startForm = (): (HTMLElement | null)[] => {
    const topic = h('textarea', { placeholder: 'موضوع جلسه: چه چیزی باید به نتیجه برسد؟', maxlength: '400', dir: 'auto', rows: '3' }) as HTMLTextAreaElement;
    const boxes = people.map((p) => {
      const cb = h('input', { type: 'checkbox', checked: true, value: p.id }) as HTMLInputElement;
      return { cb, row: h('label.mt-pick', {}, cb, ` ${p.name}`) };
    });
    const go = h('button.btn.primary', { type: 'button', onclick: async () => {
      const members = boxes.filter((b) => b.cb.checked).map((b) => b.cb.value);
      if (!topic.value.trim() || !members.length) return void (msg.textContent = 'موضوع و دست‌کم یک نفر لازم است');
      if (await call('start', { topic: topic.value, members })) toast('جلسه شروع شد');
    } }, '🤝 شروع جلسه');
    const past = state.past.length
      ? h('div.mg-box', {}, h('h4', {}, 'جلسه‌های قبلی'), ...state.past.map((p) => h('div.mg-note', { dir: 'auto' }, h('b', {}, `${p.topic}`), p.summary ? `\n${p.summary}` : ` · ${p.said} گفته، بدون جمع‌بندی`)))
      : null;
    return [h('div.mg-box', {}, h('h4', {}, 'جلسه‌ی تازه'), topic, h('div.mt-picks', {}, ...boxes.map((b) => b.row)), h('div.mg-empty', {}, 'همه سر میز اتاق جلسه می‌نشینند (تا ۵ نفر). کسی استخدام نمی‌شود.'), go), past];
  };

  const live = (m: Meeting): (HTMLElement | null)[] => {
    const rounds = [...new Set(m.said.map((s) => s.round))].sort((a, b) => a - b);
    const waiting = m.members.filter((x) => !m.said.some((s) => s.id === x.id && s.round === m.round)).map((x) => x.name);
    const feed = h('div.mt-feed', {}, ...(rounds.length ? rounds.flatMap((r) => [
      h('div.mt-round', {}, `دور ${r}`),
      ...m.said.filter((s) => s.round === r).map((s) => h('div.mg-note', { class: s.id ? '' : 'you', dir: 'auto' }, h('b', {}, `${s.by}: `), s.text)),
    ]) : [h('div.mg-empty', {}, 'هنوز کسی چیزی نگفته…')]));
    const say = h('input', { placeholder: 'شما هم بگویید…', maxlength: '3000', dir: 'auto' }) as HTMLInputElement;
    const send = async () => { if (say.value.trim() && (await call('say', { text: say.value }))) say.value = ''; };
    say.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
    return [
      h('div.mg-box', {}, h('h4', {}, `موضوع: ${m.topic}`), h('div.muted', {}, `دور ${m.round} · ${m.members.map((x) => x.name).join('، ')}`),
        h('div.mg-empty', {}, waiting.length ? `هنوز در این دور نگفته‌اند: ${waiting.join('، ')}` : 'همه در این دور گفته‌اند')),
      feed,
      m.summary ? h('div.mg-box', {}, h('h4', {}, '📝 جمع‌بندی مدیر'), h('div', { style: 'white-space:pre-wrap', dir: 'auto' }, m.summary)) : null,
      h('div.mg-box', {}, say, h('div.mg-row', {},
        h('button.btn', { type: 'button', onclick: () => void send() }, 'گفتن'),
        h('button.btn', { type: 'button', title: 'نظرهای این دور را به همه می‌دهد تا جواب بدهند', onclick: () => void call('next') }, '↻ دور بعد'),
        h('button.btn', { type: 'button', title: 'از مدیر می‌خواهد تصمیم‌ها و کارهای بعدی را بنویسد', onclick: () => void call('summarise') }, '📝 جمع‌بندی توسط مدیر'),
        h('button.btn.primary', { type: 'button', onclick: () => void call('end') }, '✓ پایان جلسه'))),
    ];
  };

  const render = () => body.replaceChildren(...(state.current ? live(state.current) : startForm()).filter((x): x is HTMLElement => !!x));

  const load = async () => {
    try {
      const res = await fetch(`/api/team/meeting?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      state = (await res.json()) as State;
      const sig = JSON.stringify(state);
      if (sig === seen) return;
      seen = sig;
      const active = document.activeElement;
      if (active && body.contains(active) && ['INPUT', 'TEXTAREA'].includes(active.tagName) && (active as HTMLInputElement).value) return;
      render();
    } catch {
      msg.textContent = 'ارتباط با دفتر برقرار نشد.';
    }
  };

  void load();
  timer = setInterval(() => void load(), POLL_MS);
}
