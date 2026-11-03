import type { GhCheck, GhMergeMethod, GhPull, GhPullDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h, openModal } from '../dom';
import { fa } from '../fa-locale';
import { mergeWaiters } from './api';
import { MERGE_KEY, mergePref, savePref } from './prefs';

// ---- Whether a PR can merge ---------------------------------------------------------------------

const CHECK_ICON: Record<GhCheck['state'], string> = { pass: '✅', fail: '❌', pending: '🟡', skip: '⚪' };

interface MergeStatus {
  icon: string;
  text: string;
  cls: 'ok' | 'warn' | 'bad' | 'muted';
  /** False when merging can't work at all (draft, conflicts, already merged). */
  can: boolean;
  /** GitHub could merge it on its own once the requirements pass. */
  auto: boolean;
}

/** An open PR whose branch can't merge until someone resolves conflicts with the base. */
export function conflicted(d: GhPullDetail) {
  return d.state === 'OPEN' && !d.isDraft && (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY');
}

export function mergeStatus(d: GhPullDetail): MergeStatus {
  const failing = d.checks.filter((c) => c.state === 'fail').length;
  const pending = d.checks.filter((c) => c.state === 'pending').length;
  if (d.state === 'MERGED') return { icon: '🎉', text: 'با موفقیت ادغام شد.', cls: 'ok', can: false, auto: false };
  if (d.state === 'CLOSED') return { icon: '🗑️', text: 'بدون ادغام بسته شد.', cls: 'muted', can: false, auto: false };
  if (d.isDraft) return { icon: '📝', text: 'این درخواست هنوز پیش‌نویس است. پیش از ادغام، آن را در GitHub برای بازبینی آماده کنید.', cls: 'muted', can: false, auto: false };
  if (conflicted(d))
    return { icon: '⚠️', text: `این شاخه با شاخهٔ ${d.baseRefName} تعارض دارد؛ ابتدا تعارض‌ها را برطرف کنید.`, cls: 'bad', can: false, auto: false };
  if (d.mergeStateStatus === 'BEHIND') return { icon: '⤵️', text: `شاخه از ${d.baseRefName} عقب است؛ مخزن پیش از ادغام به‌روز بودن آن را لازم دارد.`, cls: 'warn', can: true, auto: true };
  if (d.mergeStateStatus === 'BLOCKED') {
    const why = d.reviewDecision === 'CHANGES_REQUESTED' ? 'تغییرهایی درخواست شده است' : d.reviewDecision === 'REVIEW_REQUIRED' ? 'به بازبینی تأییدشده نیاز دارد' : failing ? `${failing.toLocaleString('fa-IR')} بررسی ناموفق است` : pending ? 'بررسی‌های لازم هنوز در حال اجرا هستند' : 'یکی از قوانین شاخه هنوز برقرار نیست';
    return { icon: '🚫', text: `ادغام مسدود شده است: ${why}.`, cls: 'bad', can: true, auto: true };
  }
  if (failing) return { icon: '❌', text: `${failing.toLocaleString('fa-IR')} بررسی ناموفق است؛ بااین‌حال می‌توان آن را ادغام کرد.`, cls: 'warn', can: true, auto: false };
  if (pending || d.mergeStateStatus === 'UNSTABLE') return { icon: '🟡', text: 'بررسی‌ها هنوز در حال اجرا هستند. می‌توانید اکنون یا پس از موفقیت آن‌ها ادغام کنید.', cls: 'warn', can: true, auto: true };
  if (d.mergeStateStatus === 'UNKNOWN' || d.mergeable === 'UNKNOWN') return { icon: '⏳', text: 'GitHub هنوز امکان ادغام را مشخص نکرده است. کمی بعد تازه‌سازی کنید.', cls: 'muted', can: true, auto: false };
  return { icon: '✅', text: `برای ادغام آماده است: با شاخهٔ ${d.baseRefName} تعارضی ندارد${d.checks.length ? ' و همهٔ بررسی‌ها موفق بوده‌اند' : ''}.`, cls: 'ok', can: true, auto: false };
}

export function checksList(checks: GhCheck[]) {
  const order: GhCheck['state'][] = ['fail', 'pending', 'pass', 'skip'];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return h(
    'ul.gh-checks',
    {},
    ...sorted.map((c) => h('li', {}, h('span', { 'aria-label': c.state }, CHECK_ICON[c.state]), c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.name) : h('span', {}, c.name))),
  );
}

// ---- Merge dialog -------------------------------------------------------------------------------

const METHOD_LABEL: Record<GhMergeMethod, string> = { squash: 'یکپارچه‌سازی و ادغام', merge: 'ساخت commit ادغام', rebase: 'بازپایه‌گذاری و ادغام' };

export function openMerge(it: GhPull, d: GhPullDetail, net: Net, handToWorker: () => void, onMerged: () => void) {
  const st = mergeStatus(d);
  const methods = d.repo.methods;
  let { method, deleteBranch } = mergePref(methods);
  let busy = false;

  const methodBtns = h('div.seg');
  const go = h('button.btn.primary', { type: 'button' });
  const auto = h('input', { type: 'checkbox', id: 'merge-auto' }) as HTMLInputElement;
  auto.checked = st.auto && st.cls !== 'ok';
  const renderMethods = () => {
    methodBtns.replaceChildren(
      ...methods.map((m) =>
        h('button.btn', { type: 'button', class: m === method ? 'on' : '', onclick: () => ((method = m), savePref(MERGE_KEY, { method, deleteBranch }), renderMethods()) }, METHOD_LABEL[m]),
      ),
    );
    go.textContent = auto.checked ? '⏱ پس از آماده‌شدن ادغام شود' : `🔀 ${METHOD_LABEL[method]}`;
  };
  auto.addEventListener('change', renderMethods);
  const del = h('input', { type: 'checkbox', id: 'merge-del' }) as HTMLInputElement;
  del.checked = deleteBranch;
  del.addEventListener('change', () => {
    deleteBranch = del.checked;
    savePref(MERGE_KEY, { method, deleteBranch });
  });
  const result = h('div.gh-merge-result.hidden');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  // Conflicts can't be merged from here, so fixing them is the main button.
  const worker = conflicted(d)
    ? h('button.btn.primary', { type: 'button', title: 'A new worker merges the base in, resolves the conflicts, then merges it the way picked above' }, '✨ New worker: fix conflicts & merge')
    : h('button.btn', { type: 'button', title: 'A worker fixes whatever is in the way, then merges' }, '🤖 Hand to a worker');

  const el = h(
    'div.modal.gh-merge',
    { role: 'dialog', 'aria-label': `ادغام درخواست شمارهٔ ${it.number}` },
    h('header', {}, h('h2', {}, `🔀 ادغام شمارهٔ ${it.number}`)),
    h(
      'div.body',
      {},
      h('p.gh-merge-title', {}, it.title, h('small', { dir: 'ltr' }, h('bdi', { dir: 'ltr' }, `${it.headRefName} → ${it.baseRefName}`))),
      h('div.gh-status', { class: st.cls }, h('span', {}, st.icon), st.text),
      d.checks.length ? checksList(d.checks) : null,
      h('label', { style: 'margin-top:14px' }, 'روش ادغام'),
      methodBtns,
      h('label.gh-check', { for: 'merge-del' }, del, 'پس از ادغام شاخهٔ ', h('bdi', { dir: 'ltr' }, it.headRefName), ' حذف شود'),
      st.auto ? h('label.gh-check', { for: 'merge-auto', title: 'gh pr merge --auto (the repo must allow auto-merge)' }, auto, 'پس از برآورده‌شدن پیش‌نیازها، خودکار ادغام شود') : null,
      result,
    ),
    h('footer', {}, st.can || conflicted(d) ? null : worker, h('span.grow'), cancel, conflicted(d) ? worker : go),
  );
  renderMethods();
  if (!st.can) go.disabled = true;

  const modal = openModal(el, { onClose: () => mergeWaiters.delete(it.number) });
  cancel.addEventListener('click', () => modal.close());
  worker.addEventListener('click', () => {
    modal.close();
    handToWorker();
  });
  go.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    result.className = 'gh-merge-result';
    result.replaceChildren(h('span.spinner'), auto.checked && st.auto ? 'درخواست ادغام پس از آماده‌شدن به GitHub ارسال می‌شود…' : 'در حال ادغام…');
    mergeWaiters.set(it.number, (msg) => {
      mergeWaiters.delete(it.number);
      busy = false;
      if (msg.error) {
        go.disabled = false;
        result.className = 'gh-merge-result error';
        result.replaceChildren(fa(msg.error));
        return;
      }
      modal.close();
      onMerged();
    });
    net.send({ t: 'gh.merge', number: it.number, method, deleteBranch, auto: auto.checked && st.auto });
  });
  setTimeout(() => (st.can ? go : cancel).focus(), 30);
}
