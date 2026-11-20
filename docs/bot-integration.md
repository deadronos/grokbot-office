# Bot reporting

Bot Office is opt-in. A bot keeps itself visible with a heartbeat and tells the
office what it is doing with **events**; nothing else is read from the bot.

The short version: `scripts/bo.sh` wraps every call below, including event id
generation, so a bot only needs three environment variables:

```bash
export BO_URL=https://office.example          # the Bot Office API base URL
export BO_TOKEN=...                           # this bot's token, shown once
export BO_BOT_ID=data                         # the slug the token is bound to
scripts/bo.sh start "review docs"
```

Everything after this section is what the script does, for bots that would
rather call the API themselves.

## Credentials

You need the API base URL and a **bot token** bound to your bot's slug (the
token decides the identity, not the body). Tokens are issued by the office
admin and printed once:

```bash
pnpm admin token create --kind bot --bot data
```

A bot token only works for its own bot id: a request for another bot answers
`403`, like a token of the wrong kind. Missing, unknown and revoked tokens
answer `401`. Error bodies are generic, so do not build retry logic on the
message; the reason is only in the server log, which never contains the token.

Keep the token in the environment or a file outside the repository. Never put it
in an argument: `/proc` and `ps` show arguments to every local user. The curl
examples below hand it to curl through a config on stdin:

```bash
# Reads the authorization header from stdin; the token stays out of `ps`.
bo() { curl -q -sS --max-time 5 --config - "$@"; }
```

## Register

Registration is an idempotent upsert of the public profile. The reply carries the
heartbeat cadence to use.

```bash
bo -X POST "$BO_URL/api/bots/register" \
  -H 'Content-Type: application/json' \
  -d '{"id":"data","name":"Data","role":"Code-Orchestrator","avatar":"android-gold","pod":"dev"}' \
  <<<"header = \"Authorization: Bearer $BO_TOKEN\""
# 200 {"id":"data","heartbeatIntervalSec":60,"timeoutSec":300}
```

| Field    | Rule                                                     |
| -------- | -------------------------------------------------------- |
| `id`     | lowercase slug, at most 64 chars (`[a-z0-9]`, inner `-`) |
| `name`   | 1–40 chars, sanitized                                    |
| `role`   | 1–60 chars, sanitized                                    |
| `avatar` | 1–60 chars, sanitized                                    |
| `pod`    | `command`, `dev` or `ops`                                |

`hidden` is admin-only and survives a re-register. Re-registering also counts as
a heartbeat and brings an offline bot back to `idle`.

## Heartbeat

A heartbeat only keeps the bot alive. **It does not change the bot's status**;
the office learns what the bot is doing from events. (The one exception is that a
heartbeat may report a rest state or `offline`.)

Send one every `heartbeatIntervalSec` (default 60). A bot without a heartbeat for
`timeoutSec` (default 300) is swept offline every 15 seconds: its task, label and
handoff links are cleared, `since` moves, and viewers see an `offline` event. Both
numbers come from `HEARTBEAT_INTERVAL_SEC` / `HEARTBEAT_TIMEOUT_SEC` on the
server, and the timeout must be larger than the interval.

```bash
bo -X POST "$BO_URL/api/bots/data/heartbeat" \
  -H 'Content-Type: application/json' \
  -d '{"status":"reviewing"}' \
  <<<"header = \"Authorization: Bearer $BO_TOKEN\""
# 204
```

The optional `status` is `idle`, `reviewing` or `offline`; an empty body is fine.
`working` and `waiting` come from task and handoff events, so a heartbeat that
tries to set them answers
`422 {"error":"working/waiting are set by task and handoff events, not heartbeats"}`
and changes nothing — not even the keep-alive timestamp. Coming to rest (`idle` or
`offline`) clears the bot's task and handoff links.

## Events

`POST /api/events` takes one batch of 1–20 events for the token's own bot. A
batch is applied in one transaction: it lands whole or not at all. Events are
identified by `eventId` (a ULID or a UUID) and `(bot_id, event_id)` is unique, so
replaying a batch is safe: already stored events are counted in `duplicates` and
change nothing.

```bash
bo -X POST "$BO_URL/api/events" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"botId":"data","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3ZY","type":"task_started","taskId":"issue-14","label":"bot docs"}]}' \
  <<<"header = \"Authorization: Bearer $BO_TOKEN\""
# 200 {"accepted":1,"duplicates":0,"lastSeq":42}
```

`lastSeq` is the highest event sequence after the batch, `accepted` counts newly
stored events. Optional fields: `label`, `ref` (both display text), `taskId` and
`at`. `at` is display-only and clamped to ±10 minutes around the server's time.

### Which event when

| Event              | When                                                           | Status it sets                                                                 |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `status_changed`   | a rest state or `reviewing` without a task (`status` required) | that status (`idle`/`offline` clear the links)                                 |
| `task_started`     | starting a unit of work                                        | `working`, task = `taskId`                                                     |
| `task_finished`    | the work ended (`result`: `done`, `failed` or `cancelled`)     | `idle`; a `taskId` other than the current one is recorded and the status stays |
| `handoff_sent`     | handing work to another bot (`to` + unique `handoffId`)        | `waiting` on that handoff, unless another task is still open                   |
| `handoff_accepted` | accepting a handoff addressed to you (`handoffId`)             | `working` with the handoff's label                                             |

A waiting sender is freed only when its own handoff is accepted. Going idle or
offline clears the bot's task and handoff links, so a stale `waiting` never
sticks.

**Task start** → `working`:

```bash
bo -X POST "$BO_URL/api/events" -H 'Content-Type: application/json' -d '{
  "events":[{"botId":"data","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3ZY",
             "type":"task_started","taskId":"issue-14","label":"bot docs"}]
}' <<<"header = \"Authorization: Bearer $BO_TOKEN\""
```

**Task end** → `idle`:

```bash
bo -X POST "$BO_URL/api/events" -H 'Content-Type: application/json' -d '{
  "events":[{"botId":"data","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3ZZ",
             "type":"task_finished","taskId":"issue-14","result":"done"}]
}' <<<"header = \"Authorization: Bearer $BO_TOKEN\""
```

**Handoff** → sender `waiting`; `handoffId` is yours to choose and must be unique:

```bash
bo -X POST "$BO_URL/api/events" -H 'Content-Type: application/json' -d '{
  "events":[{"botId":"data","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3Z0",
             "type":"handoff_sent","to":"wesley","handoffId":"h-14-1",
             "label":"review docs","taskId":"issue-14"}]
}' <<<"header = \"Authorization: Bearer $BO_TOKEN\""
```

**Accept** → the receiver becomes `working` with the handoff's label; the sender
goes `idle` only if this is the handoff it is waiting on:

```bash
# Sent with wesley's token; the accepted handoff must be addressed to wesley.
bo -X POST "$BO_URL/api/events" -H 'Content-Type: application/json' -d '{
  "events":[{"botId":"wesley","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3Z1",
             "type":"handoff_accepted","handoffId":"h-14-1","taskId":"issue-14"}]
}' <<<"header = \"Authorization: Bearer $BO_TOKEN\""
```

An event the server cannot apply fails the whole batch with
`422 {"error":"invalid event","index":<n>}`: a handoff to itself or to an unknown
bot, a reused `handoffId`, or a handoff the bot may not accept.

### Labels

`label` is the text shown under a bot's name, so it is public to everyone who can
see the office. Keep it short and generic; it is limited to 80 characters (after
sanitizing) and 120 for `ref`.

- Good: `issue-14`, `review docs`, `nightly build`, `waiting on CI`.
- Never: tokens, keys, URLs with credentials, personal data, customer names,
  ticket contents or anything you could not show on a screen in a shared room.
- Labels are sanitized server-side: invisible format characters are dropped,
  control characters become spaces, whitespace runs collapse and ends are
  trimmed. An empty label counts as no label.

### Scripts

`scripts/bo.sh` is a bash + curl one-liner for all of the above. It reads
`BO_URL`, `BO_TOKEN` and `BO_BOT_ID` from the environment and never prints the
token or puts it on a command line.

| Command                                       | Event / route                                                        |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `bo.sh register [name] [role] [avatar] [pod]` | `POST /api/bots/register`                                            |
| `bo.sh heartbeat [idle\|reviewing\|offline]`  | `POST /api/bots/<id>/heartbeat`                                      |
| `bo.sh start "<label>" [taskId]`              | `task_started` (alias `task-start`)                                  |
| `bo.sh done [taskId] [result]`                | `task_finished` (alias `finish`)                                     |
| `bo.sh handoff <bot> "<label>" [taskId]`      | `handoff_sent`, prints `handoffId:` on stderr (alias `handoff-send`) |
| `bo.sh accept <handoffId> [taskId]`           | `handoff_accepted` (alias `handoff-accept`)                          |
| `bo.sh event '<json>'`                        | one raw event object; `botId` and `eventId` are filled in            |

It generates the `eventId` (and the `handoffId` for a send), retries a `429`
after the server's `Retry-After` (up to three times, using the default of 2
seconds when the header is missing or not a number), and exits non-zero on any
other status. `register` falls back to `BO_NAME`, `BO_ROLE`, `BO_AVATAR` and
`BO_POD` (defaults: the bot id, `bot`, `robot`, `dev`).

## Auth

Every bot request carries `Authorization: Bearer <bot token>`. The token is not
accepted in the query string. Authorization headers are never logged, and the
server logs a rejection reason without the token.

## Limits and errors

- Request bodies on `/api/*` are capped at **16 KB** (`413`).
- An event batch holds **1–20** events.
- Rate limits are token buckets per bot token: `RATE_LIMIT_PER_MIN` (default 60)
  per minute with `RATE_LIMIT_BURST` (default 20) at once. Over the limit the
  answer is `429 {"error":"rate limited"}` with a `Retry-After` header in
  seconds; wait that long and retry. `GET /api/health` is exempt.

| Status | Body                                                                             | Meaning                                                    |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `400`  | `{"error":"invalid body"}`                                                       | the JSON does not match the schema (unknown keys included) |
| `400`  | `{"error":"invalid JSON body"}`                                                  | a heartbeat body that is not JSON                          |
| `400`  | `{"error":"invalid bot id"}`                                                     | the slug in the path is not a lowercase slug               |
| `401`  | `{"error":"unauthorized"}`                                                       | missing, unknown or revoked token                          |
| `403`  | `{"error":"forbidden"}`                                                          | the token belongs to another bot or is not a bot token     |
| `413`  | `{"error":"payload too large"}`                                                  | over 16 KB                                                 |
| `422`  | `{"error":"working/waiting are set by task and handoff events, not heartbeats"}` | a heartbeat tried to set `working`/`waiting`               |
| `422`  | `{"error":"invalid event","index":<n>}`                                          | the whole batch was rolled back; `index` is 0-based        |
| `429`  | `{"error":"rate limited"}`                                                       | over the token budget; honour `Retry-After`                |

The API answers `204` with no body for a heartbeat and `200` with JSON for
register and events. Times are the server's: every event in a batch shares one
`received_at`.

`GET /api/health` returns `{"ok":true,"service":"grokbot-office-server"}` and is
useful as a reachability check.
