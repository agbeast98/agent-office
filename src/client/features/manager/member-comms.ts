import { h, openModal, toast } from '../../ui/dom';
import type { Member } from './members-types';

// The 📡 ارتباط tab of the member window, and the window with every message that went between members: whom a
// member may call and whom they accept a call from (see server/team-comms.ts), whom that comes to in the end,
// and what was said. A call goes only when both sides allow it.

type Scope = 'manager' | 'team' | 'all' | 'people';
interface Rule { send: Scope; sendTo: string[]; receive: Scope; receiveFrom: string[]; set: boolean }
interface Row { id: string; name: string; post: string; team?: string; manager: boolean; rule: Rule; canCall: string[]; canHear: string[] }
interface Msg { id: string; at: number; from: string; fromName: string; to: string; toName: string; text: string; status: 'queued' | 'sent' | 'delivered' | 'failed' | 'refused'; reason?: string; depth: number }
interface State { members: Row[]; log: Msg[] }

const SCOPE_FA: [Scope, string][] = [['manager', 'فقط مدیر تیمش'], ['team', 'مدیر و هم‌تیمی‌ها'], ['all', 'همه (هر تیم، هر کس)'], ['people', 'فقط افراد مشخص']];
const STATUS_FA: Record<Msg['status'], string> = { queued: 'در صف', sent: 'داده شد', delivered: 'رسید و شروع شد', failed: 'نرسید', refused: 'رد شد' };

async function read(floor: string): Promise<State | undefined> {
  try {
    const res = await fetch(`/api/comms?${new URLSearchParams({ floor })}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as State) : undefined;
  } catch {
    return undefined;
  }
}

const when = (at: number) => new Date(at).toLocaleString('fa-IR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function msgRow(m: Msg, me?: string): HTMLElement {
  const dir = me ? (m.from === me ? `← به ${m.toName}` : `→ از ${m.fromName}`) : `${m.fromName} ← ${m.toName}`;
  return h('div.mb-msg', { class: m.status },
    h('div.mb-msg-head', {}, h('b', {}, dir), h('span.mb-chip', { class: `cm-${m.status}` }, STATUS_FA[m.status]), h('small', {}, when(m.at))),
    h('p', { dir: 'auto' }, m.text),
    m.reason ? h('small.mb-msg-why', {}, m.reason) : null);
}

/** The tab: the two settings of one member, whom they reach, and their latest messages. */
export async function commsTab(m: Member, floor: string, post: (url: string, payload: Record<string, unknown>) => Promise<boolean>, reload: () => void): Promise<HTMLElement> {
  const state = await read(floor);
  const row = state?.members.find((x) => x.id === m.id);
  if (!state || !row) return h('p.mg-empty', {}, 'اطلاعات ارتباط خوانده نشد.');
  const others = state.members.filter((x) => x.id !== m.id);
  const draft = { send: row.rule.send, sendTo: new Set(row.rule.sendTo), receive: row.rule.receive, receiveFrom: new Set(row.rule.receiveFrom) };

  const picker = (title: string, hint: string, scopeKey: 'send' | 'receive', listKey: 'sendTo' | 'receiveFrom') => {
    const list = h('div.mb-people');
    const select = h('select', { 'aria-label': title }, ...SCOPE_FA.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    select.value = draft[scopeKey];
    const draw = () => {
      list.classList.toggle('hidden', draft[scopeKey] !== 'people');
      list.replaceChildren(...others.map((o) => h('label.mb-pickrow', {}, h('input', { type: 'checkbox', checked: draft[listKey].has(o.id), onchange: (e: Event) => {
        (e.target as HTMLInputElement).checked ? draft[listKey].add(o.id) : draft[listKey].delete(o.id);
      } }), h('span', {}, o.name), h('small', {}, o.post || o.team || ''))));
    };
    select.addEventListener('change', () => { draft[scopeKey] = select.value as Scope; draw(); });
    draw();
    return h('section.mb-section', {}, h('h4', {}, title), h('small.muted', {}, hint), select, list);
  };

  const names = (idsList: string[]) => idsList.map((id) => state.members.find((x) => x.id === id)?.name).filter(Boolean) as string[];
  const chips = (list: string[], empty: string) => h('div.mb-chips', {}, ...(list.length ? list.map((n) => h('span.mb-chip', {}, n)) : [h('span.muted', {}, empty)]));
  const mine = state.log.filter((x) => x.from === m.id || x.to === m.id).slice(-12).reverse();

  const save = async (team: boolean) => {
    const ok = await post('/api/comms/action', { action: team ? 'rule_team' : 'rule', worker: m.id, send: draft.send, sendTo: [...draft.sendTo], receive: draft.receive, receiveFrom: [...draft.receiveFrom] });
    if (ok) { toast(team ? 'برای همه‌ی تیم ذخیره شد' : 'ذخیره شد'); reload(); }
  };

  return h('div.mb-view', {},
    h('p.muted', {}, `هر پیام فقط وقتی می‌رود که هر دو طرف اجازه داده باشند: فرستنده بتواند به او بدهد و گیرنده از او بپذیرد. جواب‌دادن به کسی که صدایت زده همیشه آزاد است. شما همیشه آزادید.${row.rule.set ? '' : ' (الان تنظیم پیش‌فرض است.)'}`),
    picker(`📤 ${m.name} می‌تواند به چه کسانی پیام بدهد و صدایشان بزند`, 'اگر کسی قبول نکند، پیام نمی‌رود و در ثبت پیام‌ها «رد شد» می‌آید.', 'send', 'sendTo'),
    picker(`📥 ${m.name} از چه کسانی پیام می‌پذیرد`, 'پیام همکار «درخواست» است و بر قوانین و تأیید شما مقدم نیست.', 'receive', 'receiveFrom'),
    h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: () => void save(false) }, 'ذخیره'),
      m.team ? h('button.btn', { type: 'button', title: 'همین دو تنظیم برای مدیر و همه‌ی اعضای تیمش هم گذاشته شود', onclick: () => { if (confirm(`این تنظیم برای همه‌ی تیم «${m.team?.name}» اعمال شود؟`)) void save(true); } }, '👥 اعمال به همه‌ی تیم') : null),
    h('section.mb-section', {}, h('h4', {}, 'الان در عمل'), h('small.muted', {}, `${m.name} می‌تواند صدا بزند:`), chips(names(row.canCall), 'هیچ‌کس'), h('small.muted', {}, 'و این‌ها می‌توانند او را صدا بزنند:'), chips(names(row.canHear), 'هیچ‌کس')),
    h('section.mb-section', {}, h('h4', {}, 'آخرین پیام‌ها'), ...(mine.length ? mine.map((x) => msgRow(x, m.id)) : [h('p.mg-empty', {}, 'هنوز پیامی نبوده.')])));
}

/** Every message between members, newest first. */
export async function openCommsLog(floor: string) {
  const body = h('div.mb-body');
  const el = h('div.modal.mbwin', { role: 'dialog', 'aria-label': 'پیام‌های بین اعضا', lang: 'fa', dir: 'rtl' },
    h('header', {}, h('div.mb-title', {}, h('h2', {}, '📨 پیام‌های بین اعضا'), h('small', {}, 'هر پیام با فرستنده، گیرنده، زمان و نتیجه‌ی رسیدنش'))), body);
  openModal(el, { doing: 'در پیام‌های اعضا' });
  const draw = async () => {
    const s = await read(floor);
    if (!el.isConnected) return;
    body.replaceChildren(h('div.mb-view', {}, ...(s?.log.length ? [...s.log].reverse().map((m) => msgRow(m)) : [h('p.mg-empty', {}, s ? 'هنوز پیامی بین اعضا نرفته.' : 'خوانده نشد.')])));
  };
  await draw();
  const timer = setInterval(() => void draw(), 4000);
  const stop = new MutationObserver(() => { if (!el.isConnected) { clearInterval(timer); stop.disconnect(); } });
  stop.observe(document.body, { childList: true, subtree: true });
}
