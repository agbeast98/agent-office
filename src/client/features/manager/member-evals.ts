import { h, toast } from '../../ui/dom';
import { faDate } from './members-types';
import type { Member } from './members-types';

// The 📊 ارزیابی‌ها tab of the member window: every evaluation of this member that an evaluator recorded (see
// the record_evaluation tool), with its evidence, what was proposed for the profile and where it stands.

interface Evaluation { id: string; at: number; byName: string; member: string; memberName: string; summary: string; strengths: string[]; weaknesses: string[]; lessons: string[]; proposal: string; status: 'proposed' | 'approved' | 'applied' | 'declined' }

const STATUS_FA: Record<Evaluation['status'], string> = { proposed: 'پیشنهاد شده', approved: 'تأیید شد', applied: 'اعمال شد', declined: 'رد شد' };

export async function evalsTab(m: Member, floor: string, reload: () => void): Promise<HTMLElement> {
  let all: Evaluation[] = [];
  try {
    const res = await fetch(`/api/ledgers?${new URLSearchParams({ floor })}`, { cache: 'no-store' });
    if (res.ok) all = ((await res.json()) as { evals: Evaluation[] }).evals;
  } catch {
    return h('p.mg-empty', {}, 'ارزیابی‌ها خوانده نشد.');
  }
  const mine = all.filter((e) => e.member === m.id || e.memberName === m.name);
  const set = async (id: string, status: string) => {
    const res = await fetch(`/api/ledgers/action?${new URLSearchParams({ floor })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'eval_status', id, status }) });
    if (res.ok) { toast('ذخیره شد'); reload(); } else toast('انجام نشد', 'error');
  };
  const bullets = (title: string, items: string[]) => (items.length ? h('div.mb-eval-list', {}, h('b', {}, title), h('ul', {}, ...items.map((i) => h('li', { dir: 'auto' }, i)))) : null);
  const card = (e: Evaluation) => h('article.mb-section.mb-eval', {},
    h('div.mb-msg-head', {}, h('b', {}, `${e.id} · ارزیابی ${e.byName}`), h('span.mb-chip', { class: `ev-${e.status}` }, STATUS_FA[e.status]), h('small', {}, faDate(e.at))),
    h('p', { dir: 'auto' }, e.summary),
    bullets('✅ خوب بلد است', e.strengths), bullets('⚠️ اشتباه / ضعف', e.weaknesses), bullets('🎓 باید یاد بگیرد', e.lessons),
    e.proposal ? h('p.ib-lesson', { dir: 'auto' }, h('b', {}, 'پیشنهاد برای پروفایل: '), e.proposal) : null,
    h('div.mg-row', {},
      e.status === 'proposed' ? h('button.btn.primary', { type: 'button', onclick: () => void set(e.id, 'approved') }, '✓ تأیید') : null,
      e.status === 'proposed' || e.status === 'approved' ? h('button.btn', { type: 'button', onclick: () => void set(e.id, 'declined') }, '✕ رد') : null,
      e.status === 'approved' ? h('button.btn', { type: 'button', title: 'تغییر پروفایل انجام شده', onclick: () => void set(e.id, 'applied') }, 'اعمال شد') : null));
  return h('div.mb-view', {}, h('p.muted', {}, 'هر ارزیابی که یک ارزیاب (مثلاً مربی) ثبت کرده، با شاهدها و تغییری که برای پروفایل پیشنهاد داده. تغییر خود پروفایل فقط با تأیید شما در «📥 درخواست از شما» ممکن است.'),
    ...(mine.length ? mine.map(card) : [h('p.mg-empty', {}, 'هنوز ارزیابی‌ای ثبت نشده.')]));
}
