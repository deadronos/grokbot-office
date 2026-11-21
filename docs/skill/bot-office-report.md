---
name: bot-office-report
description: Optional Bot Office reporting — task start/end and handoffs, skipped entirely when BO_URL, BO_TOKEN or BO_BOT_ID is unset.
---

# Bot Office reporting

Keep the office's view of this bot accurate with a few one-line reports. This
skill is optional and never part of the actual work.

## When to report

Report a real unit of work:

- **task start** — you begin a task.
- **task end** — done, failed or cancelled.
- **handoff out** — you hand work to another bot.
- **handoff in** — you accept a handoff addressed to you.

Do not report trivial chat turns, greetings, short questions and answers, or
chatter that is not a unit of work. One report per task, not per step.

## How

Prefer `scripts/bo.sh`; it generates the `eventId`/`handoffId` and keeps the
token off the process list.

```bash
scripts/bo.sh start "<label>" [taskId]
scripts/bo.sh done [taskId] [done|failed|cancelled]
scripts/bo.sh handoff <bot> "<label>" [taskId]   # prints "handoffId: ..." on stderr
scripts/bo.sh accept <handoffId> [taskId]
```

Curl is only a fallback: `POST $BO_URL/api/events`. Pass the authorization
header through a curl config on stdin, never on the command line or in
`--header` argv, and cap it at `--max-time 5` — see the `bo()` helper and the
event bodies in `docs/bot-integration.md`.

## Labels

The label is public: it is shown under your name in the office.

- Short and generic, max 80 characters: `issue-14`, `review docs`,
  `nightly build`, `waiting on CI`.
- Never secrets: tokens, keys, URLs with credentials, personal data (PII), customer
  names, ticket contents, or anything you could not show on a screen in a
  shared room.
- Hidden bots stay hidden: never put a hidden bot's id, name or label into a
  report.

## Opt-in

If `BO_URL`, `BO_TOKEN` or `BO_BOT_ID` is unset or missing, skip this skill
entirely — do not call `bo.sh`, which would exit with an error. Tokens live only
in the bot's own secrets/env: never in this skill, notes, prompts or
command-line arguments. (Some trackers call this token `BOT_OFFICE_TOKEN`;
`bo.sh` reads the same bot token as `BO_TOKEN`.)

## Failures never block the task

`bo.sh` exits non-zero when the office is unreachable or answers outside 2xx.
Catch or ignore that status, never abort the user's task over it, and do not
retry in a tight loop. The work is the priority; the report is a side effect.

Full details: `docs/bot-integration.md` and `scripts/bo.sh`.
