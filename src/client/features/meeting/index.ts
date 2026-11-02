/** The meeting room: E there (or 🤝 in the menu) opens its window, how the meeting's going or the form to call one. */
import { MEETING_PATTERNS } from '../../../shared/meetings';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { openMeeting, type MeetingPreset } from '../../ui/meeting';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    meeting: true;
  }
}

export function installMeeting(ctx: Ctx, parts: Pick<Parts, 'waiting' | 'actions'>) {
  /** The meeting room's window: how the meeting's going, or the form to call one (prefilled from an issue or a PR). */
  function showMeeting(preset?: MeetingPreset) {
    openMeeting(
      ctx.net,
      {
        openTerminal: (id) => parts.waiting.openWorkerTerminal(id),
        openPr: (id) => {
          const w = store.workers.get(id);
          if (w) parts.actions.pullRequestFor(w);
        },
      },
      preset,
    );
  }

  ctx.interactions.define('meeting', {
    reach: 7,
    hint: () => {
      const m = store.meeting.current;
      const p = m && MEETING_PATTERNS[m.pattern];
      const names: Record<string, string> = { debate: 'گفت‌وگوی چالشی', lead: 'راهبر و تیم', mapreduce: 'تقسیم و جمع‌بندی', redblue: 'حمله و دفاع', review: 'گروه بازبینی' };
      const what = !m || !p ? 'اتاق جلسه آماده است' : m.status === 'running' ? `${p.icon} ${names[m.pattern] ?? p.label} · دور ${m.round} از ${m.rounds}` : `${p.icon} ${names[m.pattern] ?? p.label} · ${m.status === 'done' ? 'پایان‌یافته ✅' : 'متوقف‌شده ⛔'}`;
      return { k: what, parts: [hintTitle('🤝 اتاق جلسه'), aside(clip(what, 50)), key('E', m?.status === 'running' ? 'دیدن روند جلسه' : m ? 'دیدن یا برگزاری جلسه' : 'برگزاری جلسه')] };
    },
    use: onE(() => showMeeting()),
  });

  return { showMeeting };
}
