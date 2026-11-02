# The team: manager's computer

Back to the [README](../README.md). Persian-speaking teams run the floor's agents like a small company: a manager hands out work, everyone else asks the manager, and the person (the boss) approves anything that sends, pays or deletes.

Open it from **☰ → 👑 کامپیوتر مدیر** (the monitor in the boss office on the loft).

## What's in it

- **Tasks.** Five columns (to do, doing, review, blocked, done). The manager creates and hands out tasks (`create_task`); everyone else moves their own along (`update_task`, `add_task_note`) or asks the manager (`ask_manager`). Tasks live in `.agent-office/team-tasks.json` on the floor.
- **Telling the team.** The box on the right sends an order to one person or to everyone. **▶ شروع روز کاری** tells the manager to read the rules and hand out the day's tasks, **📊 گزارش امروز** asks for a short report, **⏹ توقف همه** presses Esc in every agent.
- **The meeting room (🤝).** Press **E** at the meeting table (or ☰ → Meeting room, or 🤝 in the manager's computer). Call a meeting with a subject, an agenda and up to five of the people the team already has (**👥 جمع کردن همه** picks them all); they sit at the table and nobody is hired. While it is on, the window has sections:
  - **💬 Conversation:** everything said by round, who has spoken and who is still writing, and a box to speak to everyone or ask one person (they may answer again, once per question). **↻ next round** hands each the others' words, **📝** has the manager sum it up.
  - **👥 People:** who is at the table and how they are, ask or let one go, invite another into a free chair.
  - **📋 Agenda**, **✅ Decisions and tasks** (the manager records decisions with `meeting_decision` and a summary with `meeting_summary`; you can add either, and make tasks that stay with the meeting), **🗒 Your notes** (never shown to the agents) and **🗂 Past meetings**.
  - **✓ End** sends everyone back to their desks and writes the minutes to `.agent-office/meetings/<id>.md`, which any past meeting offers as a download. The office's own grouped meetings (debate, review…, which hire temporary workers) are still there under **🧩 Special meeting**.
- **Hiring lock (🔒).** While locked, no agent can be hired, by the office's own meetings, the queue or `hire_worker`. Kept across restarts.
- **Approvals.** Every agent's own browser (the **🌐 مرورگر** tab) asks before it sends or confirms. Everything waiting is listed at the top of the side panel with **✓ تأیید** and **✕ رد**. Buttons that pay, delete, withdraw or transfer ask **even in hands-off ("auto") mode**.
- **⏰ Timetable.** The weekly interview, the manager's review of the day before and the start of the working day can run by themselves, on the days and at the time you set. They only run while the office is running, and one that was due before the office opened still runs once when it does. Everything starts off.
- **Rename.** Click a person to change their name or the role they are reminded of.
- **Phone notifications.** Create `.agent-office/notify.json` on the floor (never typed by an agent): `{ "telegramToken": "…", "chatId": "…" }`. A Telegram message then goes out when an approval is waiting or a task reaches review or is blocked.

## The playground's rules

The people's job descriptions and limits are ordinary files in the floor's repository (`CLAUDE.md`, `freelance-team/roles/*.md`, `freelance-team/policy.md`): edit them, and agents read the new version the next time they start a task.
