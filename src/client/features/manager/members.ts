import './members.css';
import { h } from '../../ui/dom';
import { openMember } from './member-modal';
import { openCommsLog } from './member-comms';
import { avatar, engineKind, engineText, faNum, roleShort, STATUS_FA, type Member, type MemberCtx } from './members-types';

// The 👥 اعضای تیم page: a card for every agent (who they are, which engine and model they run on, their team,
// what they are doing and how many tasks), a search and engine filter, hiring a new member, and inviting some to
// a meeting. A card opens the member window (member-modal.ts) with the skills, memory, engine and tasks.

interface Opts extends MemberCtx {
  /** Who is ticked for a meeting; the team window keeps this set. */
  selected: Set<string>;
  onInvite: () => void;
  onHire: () => void;
}

const ENGINE_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

export function createMembers(opts: Opts) {
  let members: Member[] = [];
  let seen = '';
  let loaded = false;
  let query = '';
  let engine = '';
  const search = h('input', { type: 'search', placeholder: 'جستجوی نام یا سمت…', 'aria-label': 'جستجوی عضو', dir: 'auto' }) as HTMLInputElement;
  const filter = h('select', { 'aria-label': 'فیلتر موتور' }) as HTMLSelectElement;
  const summary = h('div.mb-summary');
  const grid = h('div.mb-grid');
  const inviteBtn = h('button.btn.primary', { type: 'button', onclick: () => opts.onInvite() }, '');
  const el = h('section.mg-panel.mb-page', {},
    h('div.mg-panel-head', {}, h('div', {}, h('h3', {}, 'اعضای تیم'), h('p', {}, 'روی هر عضو بزنید تا مهارت‌ها، حافظه، مدل و کارهایش را ببینید و ویرایش کنید.')),
      h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: () => opts.onHire() }, '＋ افزودن عضو'), h('button.btn', { type: 'button', title: 'هر پیامی که اعضا به هم داده‌اند', onclick: () => void openCommsLog(opts.floor) }, '📨 پیام‌های اعضا'), inviteBtn)),
    h('div.mb-tools', {}, search, filter), summary, grid);

  const draw = () => {
    inviteBtn.textContent = `دعوت به جلسه (${faNum(opts.selected.size)})`;
    const kinds = [...new Set(members.map(engineKind))];
    filter.replaceChildren(h('option', { value: '' }, 'همه‌ی موتورها'), ...kinds.map((k) => h('option', { value: k }, ENGINE_NAME[k] ?? k)));
    filter.value = kinds.includes(engine) ? engine : '';
    engine = filter.value;
    summary.replaceChildren(...kinds.map((k) => h('span.mb-chip', { class: `eng-${k}` }, `${ENGINE_NAME[k] ?? k}: ${faNum(members.filter((m) => engineKind(m) === k).length)}`)),
      h('span.mb-chip', {}, `کل: ${faNum(members.length)}`));
    const q = query.trim().toLowerCase();
    const shown = members.filter((m) => (!engine || engineKind(m) === engine) && (!q || `${m.name} ${m.role ?? ''}`.toLowerCase().includes(q)));
    grid.replaceChildren(...(shown.length ? shown.map(card) : [h('p.mg-empty', {}, loaded ? 'عضوی پیدا نشد.' : 'در حال خواندن…')]));
  };

  const card = (m: Member) => {
    const pick = h('input', { type: 'checkbox', checked: opts.selected.has(m.id), 'aria-label': `دعوت ${m.name} به جلسه`, onchange: (e: Event) => {
      (e.target as HTMLInputElement).checked ? opts.selected.add(m.id) : opts.selected.delete(m.id);
      inviteBtn.textContent = `دعوت به جلسه (${faNum(opts.selected.size)})`;
    } });
    const open = () => openMember(m, { ...opts, changed: () => void refresh(true) });
    const c = h('article.mb-card', { class: m.status },
      h('label.mb-pick', { title: 'برای دعوت به جلسه' }, pick),
      h('button.mb-open', { type: 'button', onclick: open, 'aria-label': `باز کردن ${m.name}` },
        h('span.mb-head', {}, avatar(m), h('span.mb-id', {}, h('b', {}, m.name), h('small', {}, roleShort(m) || 'بدون سمت'))),
        h('span.mb-chips', {},
          h('span.mb-chip', { class: `eng-${engineKind(m)}` }, engineText(m)),
          m.boss ? h('span.mb-chip.boss', {}, '👑 مدیر') : null,
          m.team ? h('span.mb-chip', {}, `${m.team.manager ? '★ ' : ''}${m.team.name}`) : null),
        h('span.mb-activity', {}, (m.status === 'working' && m.activity) || STATUS_FA[m.status] || m.status),
        h('span.mb-counts', {}, ...[['🛠', m.counts.doing, 'در حال انجام'], ['🔍', m.counts.review, 'بازبینی'], ['📥', m.counts.todo, 'انجام‌نشده'], ['✅', m.counts.done, 'تمام‌شده']].map(([icon, n, why]) => h('span', { title: String(why) }, `${icon} ${faNum(n as number)}`)))));
    return c;
  };

  /** Reads the team again; draws only when it changed, so a typed search isn't lost. */
  const refresh = async (force = false) => {
    try {
      const res = await fetch(`/api/members?${new URLSearchParams({ floor: opts.floor })}`, { cache: 'no-store' });
      if (!res.ok) return;
      const next = (await res.json()) as { members: Member[] };
      const sig = JSON.stringify(next.members);
      loaded = true;
      if (sig === seen && !force) return;
      seen = sig;
      members = next.members;
      draw();
    } catch {
      // The team window says when the office can't be reached.
    }
  };

  search.addEventListener('input', () => { query = search.value; draw(); });
  filter.addEventListener('change', () => { engine = filter.value; draw(); });
  draw();
  return { el, refresh };
}
