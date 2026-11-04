import { h, openModal, toast } from '../../ui/dom';
import { store } from '../../state';
import { agentFields, resolvedProvider } from '../../ui/provider';
import { avatar, engineText, faDate, faNum, mdLite, roleShort, STATUS_FA, TASK_FA, type Member, type MemberCtx } from './members-types';

// One member's window, opened from a card on the 👥 اعضای تیم page: a summary (name, post, engine, team, usage)
// with a box to tell them something, their skills (skill.md) and memory (memory.md) to read and edit, the
// engine and model they run on, and their tasks. Skills and memory are the files agents read at the start
// of every task, so what is saved here is what they know next time (server/http/routes/members.ts).

type Tab = 'overview' | 'skill' | 'memory' | 'engine' | 'tasks';
const TABS: [Tab, string][] = [['overview', 'نمای کلی'], ['skill', '🎯 مهارت‌ها'], ['memory', '🧠 حافظه'], ['engine', '🤖 مدل و موتور'], ['tasks', '▤ کارها']];
const FILE_NAME = { skill: 'skill.md', memory: 'memory.md' } as const;

interface Profile { slug: string | null; skill: string | null; memory: string | null }

export function openMember(m: Member, ctx: MemberCtx) {
  let tab: Tab = 'overview';
  let profile: Profile | undefined;
  const qs = new URLSearchParams({ floor: ctx.floor }).toString();
  const nav = h('nav.mb-tabs', { role: 'tablist' });
  const body = h('div.mb-body');
  const msg = h('div.mg-msg', { role: 'status' });
  const el = h('div.modal.mbwin', { role: 'dialog', 'aria-label': `عضو تیم: ${m.name}`, lang: 'fa', dir: 'rtl' },
    h('header', {}, avatar(m), h('div.mb-title', {}, h('h2', {}, m.name), h('small', {}, `${roleShort(m) || 'بدون سمت'} · ${STATUS_FA[m.status] ?? m.status}`))), nav, body, msg);
  const modal = openModal(el, { doing: `پرونده‌ی ${m.name}` });

  const post = async (url: string, payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch(`${url}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error || 'انجام نشد');
      msg.textContent = '';
      return true;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : 'انجام نشد';
      return false;
    }
  };

  const loadProfile = async () => {
    if (profile) return profile;
    try {
      const res = await fetch(`/api/members/profile?${qs}&worker=${encodeURIComponent(m.id)}`, { cache: 'no-store' });
      profile = res.ok ? ((await res.json()) as Profile) : { slug: null, skill: null, memory: null };
    } catch {
      profile = { slug: null, skill: null, memory: null };
    }
    return profile;
  };

  const tile = (label: string, value: string | HTMLElement) => h('div.mb-tile', {}, h('small', {}, label), h('b', {}, value));

  // ---- نمای کلی ----

  const overview = () => {
    const name = h('input', { value: m.name, maxlength: '60', dir: 'auto', 'aria-label': 'نام' }) as HTMLInputElement;
    const role = h('textarea', { maxlength: '300', dir: 'auto', 'aria-label': 'سمت و یادآوری نقش' }) as HTMLTextAreaElement;
    role.value = m.role ?? '';
    const cmd = h('textarea', { maxlength: '8000', dir: 'auto', placeholder: `دستور یا پیام برای ${m.name}…`, 'aria-label': 'دستور' }) as HTMLTextAreaElement;
    const u = m.usage;
    const spent = u ? (u.costKnown === false || (!u.cost && m.provider === 'codex') ? `${faNum(u.input + u.output)} توکن` : `$${u.cost.toFixed(2)} · ${faNum(u.input + u.output)} توکن`) : '—';
    return h('div.mb-view', {},
      h('div.mb-tiles', {},
        tile('وضعیت', STATUS_FA[m.status] ?? m.status),
        tile('موتور و مدل', engineText(m)),
        tile('تیم', m.team ? `${m.team.name}${m.team.manager ? ' (مدیر تیم)' : ''}` : 'بدون تیم'),
        tile('میز', m.desk),
        tile('مصرف این نشست', spent),
        tile('در تیم از', faDate(m.since)),
        tile('کارها', `${faNum(m.counts.doing)} در حال انجام · ${faNum(m.counts.review)} بازبینی · ${faNum(m.counts.done)} تمام‌شده`)),
      m.status === 'working' && m.activity ? h('p.mb-activity', {}, `الان: ${m.activity}`) : null,
      h('section.mb-section', {}, h('h4', {}, '✏️ نام و سمت'), name, role,
        h('small.muted', {}, 'سمت به‌صورت یادآوری در هر پیام به او داده می‌شود.'),
        h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: async () => {
          if (await ctx.call('person', { worker: m.id, name: name.value, role: role.value })) { toast('ذخیره شد'); ctx.changed(); modal.close(); }
        } }, 'ذخیره'))),
      h('section.mb-section', {}, h('h4', {}, `📣 دستور به ${m.name}`), cmd,
        h('div.mg-row', {}, h('button.btn.primary', { type: 'button', onclick: async () => {
          if (!cmd.value.trim()) return;
          if (await ctx.call('command', { to: m.id, text: cmd.value })) { toast('فرستاده شد'); cmd.value = ''; }
        } }, 'ارسال'))));
  };

  // ---- مهارت‌ها و حافظه ----

  const fileView = (kind: 'skill' | 'memory', p: Profile) => {
    const holder = h('div.mb-view');
    let editing = false;
    const draw = () => {
      const text = p[kind] ?? '';
      if (!editing) {
        const edit = h('button.btn', { type: 'button', onclick: () => { editing = true; draw(); } }, '✏️ ویرایش');
        holder.replaceChildren(
          h('div.mb-file-head', {}, h('small.muted', { dir: 'ltr' }, `freelance-team/people/${p.slug}/${FILE_NAME[kind]}`), edit),
          text.trim() ? mdLite(text) : h('p.mg-empty', {}, kind === 'skill' ? 'هنوز مهارتی ثبت نشده.' : 'هنوز چیزی در حافظه نیست.'),
          ...(kind === 'memory' ? [addNote()] : []));
        return;
      }
      const area = h('textarea.mb-editor', { dir: 'auto', spellcheck: 'false', maxLength: '20000', 'aria-label': FILE_NAME[kind] }) as HTMLTextAreaElement;
      area.value = text;
      holder.replaceChildren(
        h('small.muted', {}, 'این فایل را او در شروع هر کار می‌خواند؛ آنچه اینجا ذخیره کنید دفعه‌ی بعد می‌داند.'), area,
        h('div.mg-row', {},
          h('button.btn.primary', { type: 'button', onclick: async () => {
            if (!area.value.trim()) return;
            if (await post('/api/members/action', { action: 'save', worker: m.id, file: kind, text: area.value })) { p[kind] = area.value; editing = false; toast('ذخیره شد'); draw(); }
          } }, 'ذخیره'),
          h('button.btn', { type: 'button', onclick: () => { editing = false; draw(); } }, 'انصراف')));
    };
    /** A line the person adds to the memory without opening the whole file. */
    const addNote = () => {
      const input = h('input', { maxlength: '500', dir: 'auto', placeholder: 'نکته‌ای که باید همیشه یادش بماند…', 'aria-label': 'نکته‌ی تازه' }) as HTMLInputElement;
      const add = async () => {
        const line = input.value.trim();
        if (!line) return;
        const next = `${(p.memory ?? '').trimEnd()}\n- (${new Date().toISOString().slice(0, 10)}، مدیرعامل) ${line}`;
        if (await post('/api/members/action', { action: 'save', worker: m.id, file: 'memory', text: next })) { p.memory = next; toast('به حافظه اضافه شد'); draw(); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void add(); });
      return h('div.mb-addnote', {}, input, h('button.btn', { type: 'button', onclick: () => void add() }, '➕ افزودن به حافظه'));
    };
    draw();
    return holder;
  };

  // ---- مدل و موتور ----

  const engine = () => {
    const fields = agentFields(store.project, 'mb-agent', { provider: resolvedProvider(m.provider, store.project), ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) }, 'موتور', 'fa');
    const apply = h('button.btn.primary', { type: 'button', onclick: async () => {
      if (!fields.valid()) return;
      if (!confirm(`${m.name} از میزش بلند می‌شود و با موتور و مدل تازه دوباره می‌آید؛ پروفایل و حافظه‌اش می‌ماند ولی گفتگوی فعلی‌اش نه. ادامه؟`)) return;
      apply.setAttribute('disabled', '');
      const ok = await post('/api/hiring/action', { action: 'switch', worker: m.id, provider: fields.value(), model: fields.model(), effort: fields.effort() });
      apply.removeAttribute('disabled');
      if (ok) { toast(`${m.name} با موتور تازه دوباره آمد`); ctx.changed(); modal.close(); }
    } }, 'اعمال و راه‌اندازی دوباره');
    return h('div.mb-view', {},
      h('div.mb-tiles', {}, tile('الان روی', engineText(m)), tile('مدلی که نشستش می‌گوید', m.runsOn ?? '—')),
      h('section.mb-section', {}, h('h4', {}, 'تغییر موتور، مدل و میزان استدلال'), fields.element,
        h('small.muted', {}, 'روی «پیش‌فرض» بماند تا مدل پیش‌فرض همان موتور استفاده شود. مصاحبه‌ی باز باید اول تمام شود.'), h('div.mg-row', {}, apply)));
  };

  // ---- کارها ----

  const tasks = () => h('div.mb-view', {}, m.tasks.length
    ? h('div.mb-tasks', {}, ...m.tasks.map((t) => h('div.mb-task', {}, h('span', {}, h('b', {}, t.title), h('small', {}, `${t.id} · ${new Date(t.updatedAt).toLocaleDateString('fa-IR')}`)), h('span.mb-chip', { class: `st-${t.status}` }, TASK_FA[t.status] ?? t.status))))
    : h('p.mg-empty', {}, 'کاری به او سپرده نشده.'));

  const show = async () => {
    nav.replaceChildren(...TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: tab === id ? 'on' : '', 'aria-selected': String(tab === id), onclick: () => { tab = id; void show(); } }, label)));
    if (tab === 'skill' || tab === 'memory') {
      body.replaceChildren(h('p.mg-empty', {}, 'در حال خواندن…'));
      const p = await loadProfile();
      if (tab !== 'skill' && tab !== 'memory') return;
      body.replaceChildren(p.slug ? fileView(tab, p) : h('p.mg-empty', {}, 'این نفر پروفایلی ندارد؛ فقط کسانی که از پنجره‌ی «استخدام» آمده‌اند مهارت و حافظه‌ی ثبت‌شده دارند.'));
      return;
    }
    body.replaceChildren(tab === 'overview' ? overview() : tab === 'engine' ? engine() : tasks());
  };
  void show();
  return modal;
}
