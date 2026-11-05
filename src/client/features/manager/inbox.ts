import './inbox.css';
import { h, toast } from '../../ui/dom';
import { faDate, faNum } from './members-types';

// Two pages of the manager's computer: 📥 درخواست از شما (what agents need the person to do themselves: log in
// to a tool, take a step, say yes; tick it done and the agent is told to go on) and ⚠️ اشتباهات (what went wrong,
// what the agent did, and the lesson that every agent reads before work). Both read and write through
// /api/ledgers (see server/http/routes/ledgers.ts).

interface Req { id: string; at: number; fromName: string; kind: 'login' | 'action' | 'approve' | 'decision' | 'info'; title: string; detail: string; url?: string; status: 'open' | 'done' | 'declined'; note?: string; doneAt?: number; scope?: { file: string } }
interface Mistake { id: string; at: number; by: 'agent' | 'ceo' | 'assistant' | 'system'; byName: string; who?: string; what: string; did: string; cause: string; lesson: string; status: 'open' | 'learned' | 'wontfix'; note?: string }
interface Ledgers { requests: Req[]; mistakes: Mistake[] }

const KIND: Record<Req['kind'], [string, string]> = { login: ['🔑', 'ورود'], action: ['🛠', 'کار دستی'], approve: ['✅', 'تأیید'], decision: ['⚖️', 'تصمیم'], info: ['ℹ️', 'اطلاعات'] };
const BY: Record<Mistake['by'], string> = { agent: 'ایجنت', ceo: 'مدیرعامل', assistant: 'دستیار', system: 'سیستم' };

export interface InboxOpts {
  floor: string;
  /** Called when something changed that the navigation shows a count of. */
  changed: () => void;
}

async function readAll(floor: string): Promise<Ledgers | undefined> {
  try {
    const res = await fetch(`/api/ledgers?${new URLSearchParams({ floor })}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as Ledgers) : undefined;
  } catch {
    return undefined;
  }
}

async function act(floor: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/api/ledgers/action?${new URLSearchParams({ floor })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const out = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(out.error || 'انجام نشد');
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'انجام نشد', 'error');
    return false;
  }
}

/** A view that keeps its own element and redraws it when what the server has changed. */
function page(draw: (data: Ledgers, root: HTMLElement) => void, opts: InboxOpts) {
  const el = h('section.mg-panel.ib-page');
  let seen = '';
  const refresh = async (force = false) => {
    const data = await readAll(opts.floor);
    if (!data) return;
    const sig = JSON.stringify(data);
    if (sig === seen && !force) return;
    seen = sig;
    const active = document.activeElement;
    if (!force && active && el.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
    draw(data, el);
  };
  return { el, refresh: () => refresh(), redraw: () => refresh(true) };
}

// ---- 📥 درخواست از شما ----

export function createRequests(opts: InboxOpts) {
  let showDone = false;
  const view = page((data, root) => {
    const open = data.requests.filter((r) => r.status === 'open');
    const closed = data.requests.filter((r) => r.status !== 'open').slice(0, 30);
    const card = (r: Req) => {
      const [icon, label] = KIND[r.kind];
      const note = h('input', { placeholder: 'توضیح (اختیاری)', maxlength: '500', dir: 'auto', 'aria-label': 'توضیح' }) as HTMLInputElement;
      const answer = async (verdict: 'request_done' | 'request_declined') => {
        if (await act(opts.floor, { action: verdict, id: r.id, note: note.value })) { toast(verdict === 'request_done' ? `${r.fromName} خبردار شد؛ ادامه می‌دهد` : 'رد شد و خبر داده شد'); opts.changed(); await view.redraw(); }
      };
      return h('article.ib-card', { class: r.kind },
        h('div.ib-head', {}, h('span.ib-icon', {}, icon), h('div', {}, h('b', {}, r.title), h('small', {}, `${r.id} · از ${r.fromName} · ${label} · ${faDate(r.at)}`))),
        r.detail ? h('p', { dir: 'auto' }, r.detail) : null,
        r.scope ? h('p.ib-file', { dir: 'ltr' }, r.scope.file) : null,
        r.url ? h('a.ib-url', { href: r.url, target: '_blank', rel: 'noopener noreferrer', dir: 'ltr' }, r.url) : null,
        note,
        h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: () => void answer('request_done') }, r.kind === 'approve' || r.kind === 'decision' ? '✓ تأیید' : '✓ انجام دادم'),
          h('button.btn', { type: 'button', onclick: () => void answer('request_declined') }, r.kind === 'approve' || r.kind === 'decision' ? '✕ رد' : '✕ نمی‌کنم')));
    };
    const done = (r: Req) => h('div.ib-done', { class: r.status },
      h('span', {}, r.status === 'done' ? '✓' : '✕'), h('div', {}, h('b', {}, r.title), h('small', {}, `${r.id} · ${r.fromName}${r.note ? ` · ${r.note}` : ''}${r.doneAt ? ` · ${faDate(r.doneAt)}` : ''}`)),
      h('button.btn', { type: 'button', title: 'دوباره باز شود', onclick: async () => { if (await act(opts.floor, { action: 'request_open', id: r.id })) { opts.changed(); await view.redraw(); } } }, '↩'));
    root.replaceChildren(
      h('div.mg-panel-head', {}, h('div', {}, h('h3', {}, `📥 درخواست از شما (${faNum(open.length)})`), h('p', {}, 'هرچه ایجنت‌ها فقط خود شما می‌توانید انجام بدهید (ورود به ابزار، یک قدم دستی، یک تأیید). انجام دادید؟ تیک بزنید تا همان ایجنت خبردار شود و کار ادامه پیدا کند؛ شما هم می‌دانید دیگر لازم نیست.'))),
      ...(open.length ? open.map(card) : [h('p.mg-empty', {}, 'الان هیچ ایجنتی از شما چیزی نمی‌خواهد. ✓')]),
      ...(closed.length ? [h('button.btn.ib-toggle', { type: 'button', onclick: () => { showDone = !showDone; void view.redraw(); } }, `${showDone ? 'پنهان' : 'نمایش'} انجام‌شده‌ها (${faNum(closed.length)})`)] : []),
      ...(showDone ? closed.map(done) : []));
  }, opts);
  return view;
}

// ---- ⚠️ اشتباهات ----

export function createMistakes(opts: InboxOpts) {
  let filter: '' | Mistake['status'] = '';
  const view = page((data, root) => {
    const list = data.mistakes.filter((m) => !filter || m.status === filter);
    const form = () => {
      const what = h('textarea', { placeholder: 'چه شد؟ (مثلاً: ایجنت X بدون تأیید فرم را فرستاد)', maxlength: '1500', dir: 'auto', 'aria-label': 'چه شد' }) as HTMLTextAreaElement;
      const did = h('input', { placeholder: 'ایجنت چه کار کرد؟', maxlength: '500', dir: 'auto', 'aria-label': 'ایجنت چه کرد' }) as HTMLInputElement;
      const lesson = h('input', { placeholder: 'درس: از این به بعد چه کار شود؟', maxlength: '500', dir: 'auto', 'aria-label': 'درس' }) as HTMLInputElement;
      const who = h('input', { placeholder: 'درباره‌ی چه کسی؟ (اختیاری)', maxlength: '60', dir: 'auto', 'aria-label': 'درباره‌ی چه کسی' }) as HTMLInputElement;
      return h('details.ib-add', {}, h('summary', {}, '＋ ثبت یک اشتباه'), what, did, lesson, who,
        h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: async () => {
          if (!what.value.trim()) return;
          if (await act(opts.floor, { action: 'mistake_add', what: what.value, did: did.value, lesson: lesson.value, who: who.value })) { toast('ثبت شد و همه‌ی ایجنت‌ها می‌خوانند'); opts.changed(); await view.redraw(); }
        } }, 'ثبت')));
    };
    const card = (m: Mistake) => {
      const set = async (status: Mistake['status']) => { if (await act(opts.floor, { action: 'mistake_status', id: m.id, status })) { opts.changed(); await view.redraw(); } };
      return h('article.ib-card.mistake', { class: m.status },
        h('div.ib-head', {}, h('span.ib-icon', {}, m.status === 'learned' ? '✅' : m.status === 'wontfix' ? '⏸' : '⚠️'), h('div', {}, h('b', {}, m.what), h('small', {}, `${m.id} · ${m.who ? `${m.who} · ` : ''}ثبت‌کننده: ${BY[m.by]}${m.by === 'agent' ? ` (${m.byName})` : ''} · ${faDate(m.at)}`))),
        m.did ? h('p', { dir: 'auto' }, h('b', {}, 'چه کرد: '), m.did) : null,
        m.cause ? h('p', { dir: 'auto' }, h('b', {}, 'علت: '), m.cause) : null,
        m.lesson ? h('p.ib-lesson', { dir: 'auto' }, h('b', {}, 'درس: '), m.lesson) : null,
        h('div.mg-row', {}, m.status !== 'learned' ? h('button.btn', { type: 'button', title: 'درسش در کار اعمال شده', onclick: () => void set('learned') }, '✓ یاد گرفته شد') : null,
          m.status !== 'wontfix' ? h('button.btn', { type: 'button', title: 'دیگر به ایجنت‌ها گفته نمی‌شود', onclick: () => void set('wontfix') }, 'کنار بگذار') : null,
          m.status !== 'open' ? h('button.btn', { type: 'button', onclick: () => void set('open') }, '↩ دوباره باز') : null));
    };
    const filters: ['' | Mistake['status'], string][] = [['', 'همه'], ['open', 'باز'], ['learned', 'یاد گرفته‌شده'], ['wontfix', 'کنار گذاشته']];
    root.replaceChildren(
      h('div.mg-panel-head', {}, h('div', {}, h('h3', {}, `⚠️ اشتباهات (${faNum(data.mistakes.filter((m) => m.status === 'open').length)} باز)`), h('p', {}, 'هر اشتباهی که ایجنت‌ها یا شما ثبت می‌کنید، با اینکه چه شد، ایجنت چه کرد و درسش. همین فهرست در `freelance-team/mistakes.md` برای همه‌ی ایجنت‌ها نوشته می‌شود و قبل از کار می‌خوانند.'))),
      form(),
      h('div.ib-filters', {}, ...filters.map(([v, l]) => h('button.btn', { type: 'button', class: filter === v ? 'primary' : '', onclick: () => { filter = v; void view.redraw(); } }, l))),
      ...(list.length ? list.map(card) : [h('p.mg-empty', {}, 'اشتباهی در این فهرست نیست.')]));
  }, opts);
  return view;
}
