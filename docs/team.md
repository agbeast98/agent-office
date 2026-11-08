# The team: manager's computer

Back to the [README](../README.md). Persian-speaking teams run the floor's agents like a small company: a manager hands out work, everyone else asks the manager, and the person (the boss) approves anything that sends, pays or deletes.

Open it from **☰ → 👑 کامپیوتر مدیر** (the monitor in the boss office on the loft).

## What's in it

- **Tasks.** Five columns (to do, doing, review, blocked, done). The manager creates and hands out tasks (`create_task`); everyone else moves their own along (`update_task`, `add_task_note`) or asks the manager (`ask_manager`). Tasks live in `.agent-office/team-tasks.json` on the floor.
- **Telling the team.** The box on the right sends an order to one person or to everyone. **▶ شروع روز کاری** tells the manager to read the rules and hand out the day's tasks, **📊 گزارش امروز** asks for a short report, **⏹ توقف همه** presses Esc in every agent.
- **The meeting room (🤝).** Press **E** at the meeting table (or ☰ → Meeting room, or 🤝 in the manager's computer). Call a meeting with a subject, an agenda and up to five of the people the team already has (**👥 جمع کردن همه** picks them all); they sit at the table and nobody is hired. While it is on, the window has sections:
- **Chats that stay put.** The meeting room and the interview use one conversation component: only new messages are added to the list (so scrolling and selecting are never disturbed), it sticks to the newest message unless you have scrolled up (then a button jumps down), shows who is writing now and what is being waited for, reads light markdown and pictures, and the box grows as you type (Enter sends, Shift+Enter a new line). What you type is kept as a draft, even if the window is closed or the page reloaded. The meeting form (subject, agenda, mode, who comes) is made once and its draft is kept too; the other sections of the meeting window keep what is typed while they refresh.
- **Members (♙ اعضای تیم).** A card for every agent: engine and model, team, what they are doing and their task counts, with a search and an engine filter, ＋ افزودن عضو (the hiring window) and ticking people for a meeting. A card opens the member window: a summary (rename, change the post, tell them something), **🎯 مهارت‌ها** and **🧠 حافظه** (their `skill.md` and `memory.md`, read and edited here; a line can be added to the memory without opening the file), **🤖 مدل و موتور** (switch the engine, model and reasoning effort; the person is restarted from their profile) and **▤ کارها**.
- **Talking to each other (📡 ارتباط).** In the member window, each person has two settings: whom they may call (and wake) and whom they accept a call from: only their manager, the manager and teammates, everyone, or chosen people. A call goes only if both sides allow it; a reply to someone who called you always goes; you always may. Agents call with the `call_member` tool (team_roster says whom they may call: `can_call`). The message is typed into the other terminal, so it wakes them; a busy one gets it when free (it waits in a queue). The office checks it was taken up, sends it once more if not and tells you if it never was. A chain of calls stops after six (a message you send to an agent starts its count over), and a pair is limited to six messages an hour. A message from a colleague is a request, never your order. **📨 پیام‌های اعضا** (on the members page) lists every message with its outcome. Kept in `.agent-office/team-comms.json`. The روال (scenarios) button is no longer in the manager window; its code and `/api/flows` are still there.
- **Answers come back.** `tell_worker` between agents is the same call as `call_member` (rules, log, queue, check that it arrived). When the one called finishes their turn without calling back, the office brings their last answer to the one who asked ("📬"), with the reminder to summarise it for you and, if something only you can solve blocks it, to use `ask_ceo`; one stuck on a question for more than 90 seconds is reported to you. Every call also carries the rule that a blocker is said at once to whoever asked, never left only in one's own chat, and that a plain thanks gets no reply.
- **Asking you (📥 درخواست از شما).** What only you can do for an agent (log in to a tool, a manual step, a yes) goes here: an agent calls `ask_ceo` with what to do, where and why (never a password); you tick **✓ انجام دادم** (or ✕), and that agent is told to go on. A badge in the navigation counts the open ones, and the same goes to your phone if notifications are set up.
- **Mistakes (⚠️ اشتباهات).** Agents (`report_mistake`) and you write down what went wrong, what the agent did, the cause and the lesson. The list is also written to `freelance-team/mistakes.md`, which every agent reads before work (CLAUDE.md/AGENTS.md say so), so the same mistake is not made twice. Mark one learned or set it aside; the ones set aside are not told to agents.
- **Evaluations (📊 in the member window).** An evaluator (the trainer) records each evaluation with `record_evaluation`: summary, strengths, weaknesses, what to learn, what it proposes for the profile and where that stands (proposed, approved, applied, declined).
- **Profile lock.** A member changes only their own skill.md and memory.md. Changing another member's, or policy.md or the roster, is refused until you say yes for that file: the agent's attempt makes an item in 📥 درخواست از شما, and your yes lets that agent change that file for eight hours. It is checked before every Write, Edit, apply_patch and shell command that writes, for Claude Code and Codex workers (a very roundabout shell command can still get past it). A change to a skill.md that got past it (or was allowed) is reported to that member's manager.
- **The team in git.** `freelance-team/state/team-state.json` keeps who is on the team, their engines, teams, tasks, interviews, rules, requests, mistakes and evaluations inside the repository (written every minute when something changed). On another computer, a fresh clone takes the team files from it, and **📥 بازیابی تیم** on the members page starts each missing member again on a free desk from their profile (a new session: what they said before stays on the other computer). Pull before you start the office there, and let one computer run the office at a time.
  - **How it goes** is chosen when you call it: **💬 نظرخواهی** (each says their piece, you hand out the next round), **🗣 بحث بین خودشان** (a debate: each round they answer each other, naming who they answer with `to`; rounds follow by themselves, 2 to 6, then the manager is asked to sum up) or **🗳 رأی‌گیری** (a yes/no question; each votes with `meeting_vote` and a reason, secretly; it's counted when all have voted or when you press the button, and the result is kept as a decision). If someone didn't get a chair, the window says so and offers **🪑 بنشان**.
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

## 🛡 Security: a firewall for the agents you tick

A **security agent** (tick **نگهبان امنیت** on one of the team in 🛡 امنیت) guards up to five other agents; more need another security agent. Agents nobody guards are not checked. For a guarded agent everything except talking (messages, tasks, the meeting) is checked against that agent's rules first, with no tokens spent:

- **Browser:** reading sites is open or not as its rules say; sending, logging in or uploading is only allowed on the sites listed.
- **Claude Code tools:** shell commands, fetching a page, web search and files outside its own folders go through a `PreToolUse` hook that asks the office before each one. A command is allowed if it starts with an allowed command, a file if it is in its folder or a listed one.
- **Anything else is held**, the agent is told to wait, and the security agent wakes to decide it with `security_holds` and `security_decide`: allow for a while (60 minutes by default), deny, or ask you. It cannot go beyond the rules and `policy.md`; payments, deletions and accounts always go to you.
- **It learns from your answers.** When you answer the same way twice about the same site or command, it becomes a rule: allowed without asking, or refused outright. **🧠 یادگرفته‌ها** lists them and can forget one.
- The rules are also written to `freelance-team/security-rules.md` in the floor's repository, so git keeps them.

Not covered yet: Codex agents (their hooks differ), and an agent already running keeps the hooks it started with until it is resumed.

A security agent has no desk to sit at: in the 3D office it walks about the floor on its own, and when something it guards is held it walks over and stands beside that agent's desk, facing it, until it is decided, then goes back to wandering. (Its desk stays its own, empty.)

## 🧭 Scenarios and team managers

**🧭 روال‌ها** in the manager's computer. A **team manager** is a name, a team and a brief: no desk, no seat, no AI of its own. The office plays them, so waiting and passing work on cost no tokens; an AI wakes only for the step it is given.

A **scenario** is a list of steps, each given to one person:

- Each step becomes a task for its person (with the manager's brief, the project input and what the earlier steps wrote). They write the result with `add_task_note` and set `review`; the office closes it and hands the next step what was written.
- **QA step:** says yes (`review`) or sends it back (`blocked` plus each fault in notes). The faults go to the step it is set to return to, which redoes the work and everything after it. After the scenario's limit of returns the run stops and asks you.
- **هم‌زمان با بعدی:** that step and the next start together (backend and frontend); the one after waits for both.
- **منتظر تأیید من:** the run stops before this step (an upload, say) until you press **✓ تأیید و ادامه**.
- A step that gets stuck stops the run, with **↻ دوباره امتحان**; **■ توقف** cancels what is open. Every run's log is kept.

Scenarios and managers are kept in `.agent-office/team-flows.json` and written, readable, to `freelance-team/scenarios.md`. Tasks made by a scenario do not wake the team's manager worker. Not here yet: the manager choosing among several ideas by itself, a scenario starting another, and a manager with a seat.

## 🧑‍💼 Hiring and the first interview

**🧑‍💼 استخدام** in the manager's computer (and **E** at an empty desk, which now opens the same window). A map of the floor's desks shows which are free, which are taken and who is in an interview. Pick a free desk and fill in a **name**, a **post** and a **description of the job** (what it does, what each job hands back, what it must not do), then **🎤 استخدام و شروع مصاحبه**.

The new agent does not start working. It has its first interview with you, as a chat in the same window:

1. It introduces itself, then asks its questions one at a time (about you, the business, tone, what a good result is, what is forbidden); you answer in the box.
2. It says what it wants and can do, what it should not do, and what it would improve.
3. It says what access it has (its own browser with the office's `browser_*` tools, where sending and logging in need your approval) and what it still needs.
4. It writes its own profile, kept in the floor's repository so git carries it to your other computers: `freelance-team/people/<name>/skill.md` (the job, refined from what you wrote) and `memory.md` (what it learned about you and the work). It is told to read both at the start of every task and to add to `memory.md` after each.

You then press **✓ استخدام**, **✕ رد** (it goes home and its profile is deleted), or **⏭ رد شدن از مصاحبه** to hire it without the interview being finished. Until it is hired, tasks and scenarios cannot be given to it. The agent speaks through the `interview_say` and `interview_finish` tools. Not here yet: the agent walking up to the boss's loft for the interview and down to its desk afterwards (it is seated at its desk from the start).

## 📁 Projects and folder access

A floor that builds clients' projects (a dev team) keeps them in **📁 پروژه‌ها** (in the manager's computer, under 🧑‍💼 استخدام). A project has a name, a kind (**موجود**: it has code, so the team first reads it; **تازه**: a full review from scratch), its stack, how to run and test it, notes, and **folders** with a name each (`front`, `back`…) and their full paths on this computer. The paths stay in `.agent-office/projects.json` (they differ from one computer to the next); a description without them is written to `freelance-team/projects/<id>.md`, so git carries it. The whole disk, the home folder, `.ssh`, the office's own data and the like can't be given as a folder.

**Never two projects mixed up:**

- On a floor that has projects, the manager can't hand out a task without saying which (`project` in `create_task`), and every message about a task starts with `[پروژه: X]`. A floor with no projects (the content team) works exactly as before.
- **Who may use which folder** is a table in the project's card: for each agent and folder, *none*, *read* or *write*. A team's manager reads every folder by default. The folders go on the agent's command line when it starts (`--add-dir` for Claude, and for Codex the writable ones), so it needs a restart to see a new one.
- A check in front of every tool (Claude's and Codex's PreToolUse hook, `folder-gate.ts`) refuses a read or write in a project folder the agent wasn't given, or a write where it may only read, and says why. At the same time a card goes to **📥 درخواست از شما**: say yes and that agent may use that folder for eight hours. Secrets (`.env`, keys; not `.env.example`) always ask. A shell command is judged by the paths in it and the folder it runs in, so it's a guard that tells the agent where it went wrong, not a wall: a roundabout command can get through. A container is what would make it a wall.
- To start a project, the **🔎 بررسی قبلی** (existing) or **🧩 بررسی کامل** (new) button of the card opens a meeting with the ready-made agenda and the agents you tick (the meeting room has five chairs), so each gives their view before work begins. Set the project **آماده‌ی توسعه** when it's ready.

**The way the work goes:** the manager divides it; the agents do it and put it in *review*; the person reviews everything; if it's not enough the manager says what to do next; and only when the person says go does QA start (in a scenario, a QA step marked as needing the person's go). To spend as few tokens as possible, agents read only what they need, keep reports short, don't poll, and take lighter models for simple work (see the *صرفه‌جویی در توکن* section of `CLAUDE.md`).

## 🔄 Interviewing someone again

The **🔄 مصاحبه‌ی مجدد** button at the top of **🧑‍💼 استخدام** is for everyone: it lists all hired agents (each with when they were last interviewed), ticked, and starts the interview for those you keep ticked. It is meant for **evaluating** them, say once a month: each agent assesses itself with proof, and its team's manager is told to record its own evaluation of the agent (`record_evaluation`) and to say which of the proposed changes are right. A single agent can also be interviewed from the card of its desk. Click a hired person's desk in **🧑‍💼 استخدام** and press **🔄 مصاحبه‌ی مجدد** (the card shows when they were last interviewed, with ⚠️ after 30 days). This interview is **of the agent, about its own work**, not a talk with you about the business: it answers one topic at a time, from evidence, in the same chat (you can ask questions or correct it):

1. its flow (what comes in, the steps, what it hands back and to whom),
2. what it must always do,
3. what it never does, and whether each comes from `policy.md` or is its own rule,
4. what needs your (or its manager's) approval,
5. its access: what it has, needs and lacks,
6. what in its `skill.md` and `memory.md` is out of date or wrong, with proof,
7. its mistakes since the last interview and the rules they gave,
8. what would help it work better,
9. its own assessment: strengths and weaknesses since the last interview, with proof.

The rules it is given: every claim has proof (a file, a task, an output) or is called a guess; it reads its profile and compares it with the real work first; "no change" is a fine answer; only what has proof changes, your own text and the parts that are right stay and nothing is dropped silently; more freedom (access, work without approval) must be labelled «افزایش اختیار» with a reason; `policy.md`, the fixed rules and other people's profiles are never touched; and it writes no profile file itself and takes no new work until the interview ends.

At the end it sends the list of changes (added, changed or removed, why, proof) and the proposed `skill.md` and `memory.md`. **Nothing is written yet**: you see the changes and each file as a line-by-line comparison with the profile it has now (🧭 نظر مدیر works here too), then press **✓ اعمال تغییرها** (the files are replaced and the agent is told to read them again) or **✕ پروفایل بدون تغییر بماند**. The profile before the interview is also kept in the interview's record, and git keeps the files' history.

## ⚙️ Another engine, and 🚪 firing

Every hired agent's card (and the chat of an interview that is going on) has **⚙️ موتور و مدل**: pick Claude or Codex, a model and a reasoning effort, and **اعمال**. The agent stands up and comes back on the new engine with its profile and its place in the team. An interview in progress goes on from where it was: the new engine is given the same instructions and what has been said. (This is for an agent whose engine can't do what its interview needs, as happened with Codex on Windows before prompts were passed as a file.)

**🚪 اخراج** takes two steps. The first says what will happen (the team it leaves, how many open tasks it leaves behind); the second wants the agent's name typed exactly, within five minutes of the first (the server checks both). A manager whose team still has members can't be fired. The agent is sent home and its profile stays in the repository.

## 👥 Teams and their managers

There are two ways to hire (the **نوع استخدام** in the form): **🧍 مستقل** (the agent works for itself, in no team) and **👥 عضو یک تیم**. A team is made by hiring its first person as **🧭 مدیر یک تیم تازه** (the form asks for the team's name); that manager's interview is about coordination, and after it you hire the rest into the team, with the manager's say. Agents who work alone can be taken into a team later (**افزودن به تیم** in the **👥 تیم‌ها** tab, or on a manager's proposal).

A team's manager never hires. It tells you, honestly, what the team has and lacks:

- **💬 مشاوره با مدیر** (in the team's card): ask "is what we have enough?" or what the team needs; the manager answers with `team_advise` and, for each person it thinks is missing, `propose_hire` (post, a draft of the skill, why): a card with **✓ استخدام با این مشخصات**, which fills the hire form in. It may as well say the team is enough, or that one more of something is not needed. `propose_adopt` proposes taking in someone who works alone.
- **In an interview** the manager is not part of every message. It comments when the candidate finishes, and when you press **🧭 نظر مدیر**: the comment is shown in the same chat with its name, and the candidate does not see it. The manager's own interview has no one to judge it.
- **`freelance-team/people/ROSTER.md`**, made by the office after every change, says who is in which team, each one's post and the access they say they have and need. Managers read it (or `team_roster`) at the start of work.
- Anyone who manages a team may hand out tasks like the floor's manager. Agents can no longer hire each other (`hire_worker` is refused with a note to ask the manager or propose).

Kept in `.agent-office/team-teams.json`. Not here yet: more than one manager receiving the "needs review" notices (they go to the first), and walking up to the loft for the interview.

## How a Codex worker is started

Codex asks before it trusts a hook and before it runs a command outside its sandbox, and a question in a terminal nobody watches only stops the agent. So the office starts every Codex worker with `--dangerously-bypass-hook-trust` (the hook file is the office's own, shared by all floors) and with the network on inside its workspace-write sandbox (`-c sandbox_workspace_write.network_access=true`), so installs and downloads work. Approvals for a command are left to Codex. `AGENT_OFFICE_CODEX_PERMISSIONS=ask` starts them the old way. After the office starts again it tells each running agent which of its tasks were still `doing`, once, so the work carries on without someone nudging the manager; a task about a project also carries the folders the agent may use there and where they are.

A floor can run its Codex workers with **full access**: put `{"mode":"full"}` in `codex-access.json` in the floor's `.agent-office` folder (it is per computer and not committed). They then start with `--dangerously-bypass-approvals-and-sandbox` and ask nothing, which a dev team needs because Codex's sandbox keeps `.git` read-only, so every commit and branch stopped at a question, and its "don't ask again" remembers only that one exact command. The office's folder and profile gates, and the floor's `policy.md`, are what hold the agents then. Leave it out for a floor that must stay tightly held (the content team has none).
