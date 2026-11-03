import type { GhCloseReason, GhIssue, GhPull } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store, workerForPull } from '../../state';
import { h, openModal } from '../dom';
import { fa } from '../fa-locale';
import { closeWaiters } from './api';

// ---- Close dialog -------------------------------------------------------------------------------

const REASON_LABEL: Record<GhCloseReason, string> = { completed: '✅ انجام شد', 'not planned': '🚫 در برنامه نیست' };

/** Closes an issue (as completed or not planned) or a PR without merging, with an optional comment. */
export function openClose(kind: 'issue' | 'pull', it: GhIssue | GhPull, net: Net, onClosed: () => void) {
  const key = `${kind}:${it.number}`;
  const pull = kind === 'pull' ? (it as GhPull) : null;
  let reason: GhCloseReason = 'completed';
  let busy = false;

  const go = h('button.btn.danger', { type: 'button' });
  const reasons = h('div.seg');
  const renderReasons = () => {
    reasons.replaceChildren(...(Object.keys(REASON_LABEL) as GhCloseReason[]).map((r) => h('button.btn', { type: 'button', class: r === reason ? 'on' : '', onclick: () => ((reason = r), renderReasons()) }, REASON_LABEL[r])));
    go.textContent = pull ? '🚫 بستن درخواست ادغام' : `${reason === 'completed' ? '✔️' : '🚫'} بستن به‌عنوان «${reason === 'completed' ? 'انجام‌شده' : 'در برنامه نیست'}»`;
  };
  const comment = h('textarea', { rows: 4, placeholder: 'Leave a comment (optional)', 'aria-label': 'Closing comment' }) as HTMLTextAreaElement;
  const del = h('input', { type: 'checkbox', id: 'close-del' }) as HTMLInputElement;
  const w = pull && workerForPull(store.workers.values(), pull);
  const result = h('div.gh-merge-result.hidden');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const noun = pull ? 'درخواست ادغام' : 'مشکل';

  const el = h(
    'div.modal.gh-merge',
    { role: 'dialog', 'aria-label': `بستن ${noun} شمارهٔ ${it.number}` },
    h('header', {}, h('h2', {}, `${pull ? '🚫' : '✔️'} بستن ${noun} شمارهٔ ${it.number}`)),
    h(
      'div.body',
      {},
      h('p.gh-merge-title', {}, it.title, pull ? h('small', { dir: 'ltr' }, h('bdi', { dir: 'ltr' }, `${pull.headRefName} → ${pull.baseRefName}`)) : null),
      pull
        ? h('div.gh-status.muted', {}, h('span', {}, 'ℹ️'), 'این درخواست ادغام نمی‌شود و بعداً می‌توانید آن را در GitHub دوباره باز کنید.', w ? h('span', {}, ' ', h('bdi', { dir: 'auto' }, w.name), ' هنوز پشت میزش و مشغول کار روی شاخه است.') : null)
        : h('label', {}, 'دلیل'),
      pull ? h('label.gh-check', { for: 'close-del' }, del, 'حذف شاخهٔ ', h('bdi', { dir: 'ltr' }, pull.headRefName), ' هم انجام شود') : reasons,
      comment,
      result,
    ),
    h('footer', {}, h('span.grow'), cancel, go),
  );
  renderReasons();

  const modal = openModal(el, { onClose: () => closeWaiters.delete(key) });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    result.className = 'gh-merge-result';
    result.replaceChildren(h('span.spinner'), `در حال بستن ${noun}…`);
    closeWaiters.set(key, (msg) => {
      closeWaiters.delete(key);
      busy = false;
      if (msg.error) {
        go.disabled = false;
        result.className = 'gh-merge-result error';
        result.replaceChildren(fa(msg.error));
        return;
      }
      modal.close();
      onClosed();
    });
    net.send({ t: 'gh.close', kind, number: it.number, comment: comment.value.trim() || undefined, reason: pull ? undefined : reason, deleteBranch: !!pull && del.checked });
  });
  setTimeout(() => comment.focus(), 30);
}
