// What ties hiring to the teams' managers (see team-teams.ts, team-interviews.ts, routes/hiring.ts): the roster
// file the managers read, and the words that wake a manager to advise or to comment on an interview.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Floor } from './floor.js';
import { tell } from './hooks/office-tasks.js';
import type { Interview } from './team-interviews.js';
import { rosterText } from './team-teams.js';

/** freelance-team/people/ROSTER.md: who is in which team and what each is, from the profiles and interviews. */
export function writeRoster(floor: Floor) {
  const dir = floor.interviews.peopleDir;
  if (!dir) return;
  const people = floor.workers.list().filter((w) => w.kind === 'agent').map((w) => {
    const open = floor.interviews.open(w.id);
    const done = floor.interviews.all().filter((i) => i.worker === w.id).pop();
    const access = (open ?? done)?.access?.replace(/\s+/g, ' ').slice(0, 220);
    return { id: w.id, name: w.name, role: w.role, state: open ? 'در مصاحبه' : undefined, line: access ? `دسترسی: ${access}` : undefined };
  });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ROSTER.md'), rosterText(floor.teams.teams, people), 'utf8');
  } catch {
    // The teams still hold; only the readable copy is behind.
  }
}

/** Words to a team's manager, waking it if it is asleep. */
export function tellManager(floor: Floor, teamId: string, body: string, by: string) {
  const team = floor.teams.get(teamId);
  if (!team) return;
  tell(floor, [{ to: team.manager, text: body }], by);
}

/** The person asks their manager whether the team is enough, or what it needs. */
export function askAdvice(floor: Floor, teamId: string, question: string, by: string) {
  const team = floor.teams.get(teamId);
  tellManager(floor, teamId, [
    `مدیرعامل (${by}) درباره‌ی تیم «${team?.name}» از تو می‌پرسد:`,
    question,
    'فهرست افراد و تیم‌ها را در freelance-team/people/ROSTER.md بخوان (یا با team_roster). جواب واقع‌گرایانه بده، نه تعارف: اگر نیروهای فعلی برای این کار کافی‌اند صریح بگو کافی است؛ اگر نه بگو دقیقاً چه چیزی کم است و چرا. جوابت را با team_advise بنویس و برای هر نیروی تازه‌ای که لازم می‌دانی جداگانه propose_hire (سمت، شرح مهارت پیشنهادی، دلیل) را صدا بزن. استخدام با خود مدیرعامل است، نه تو.',
  ].join('\n\n'), by);
}

/** A manager is asked what it makes of a candidate's interview, so far or at its end. */
export function askAboutInterview(floor: Floor, i: Interview, finished: boolean) {
  // The manager's own interview has no manager to judge it.
  if (!i.team || i.isManager) return;
  const said = i.messages.slice(-12).map((m) => `${m.by === 'agent' ? i.name : m.by === 'boss' ? 'مدیرعامل' : `مدیر ${m.who ?? ''}`}: ${m.text}`).join('\n');
  tellManager(floor, i.team, [
    finished
      ? `${i.name} (سمت: ${i.role}) ${i.kind === 'review' ? 'مصاحبه‌ی بازبینی را تمام کرد و تغییراتی برای پروفایلش پیشنهاد داد (هنوز اعمال نشده)' : 'مصاحبه‌ی اولیه را تمام کرد'}. پروفایلش در freelance-team/people/${i.slug}/skill.md و memory.md است.`
      : `مدیرعامل از تو نظر می‌خواهد درباره‌ی ${i.kind === 'review' ? 'مصاحبه‌ی بازبینی' : 'مصاحبه‌ی'} در جریان با ${i.name} (سمت: ${i.role}).`,
    `آخرین گفتگو:\n${said || '(هنوز چیزی گفته نشده)'}`,
    `نظرت را با team_advise و interview: "${i.id}" بگو، واقع‌گرایانه و کوتاه: آیا مهارت و شرح کارش با نیاز تیم می‌خواند، چه چیزی کم یا زیاد است، دسترسی‌هایی که می‌گوید لازم دارد درست است یا نه، و آیا این نفر برای تیم لازم است. این نظر به خود او نمی‌رسد؛ مدیرعامل می‌بیند.`,
  ].join('\n\n'), 'سیستم');
}
