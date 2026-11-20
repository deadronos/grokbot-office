#!/usr/bin/env bash
# bo.sh - opt-in reporting for one Grokbot Office bot.
#
#   BO_URL=https://office.example BO_TOKEN=... BO_BOT_ID=data \
#     scripts/bo.sh start "review docs"
#
# The token comes from the environment only and reaches curl through a config on
# stdin, so it never shows up in the process list. Labels are public: keep them
# short and generic (no secrets, no PII, no task content).
set -euo pipefail

CURL_MAX_TIME=5
MAX_RETRIES=3
DEFAULT_RETRY_SEC=2

usage() {
  cat <<'EOF'
usage: bo.sh <command> [args]

  register [name] [role] [avatar] [pod]   register or update this bot
  heartbeat [idle|reviewing|offline]      keep the bot alive (aliases: hb)
  start "<label>" [taskId]                task_started
  done [taskId] [done|failed|cancelled]   task_finished (aliases: finish)
  handoff <bot> "<label>" [taskId]        handoff_sent, prints the handoffId
  accept <handoffId> [taskId]             handoff_accepted
  event '<json>'                          one raw event object, e.g.
                                          '{"type":"status_changed","status":"reviewing"}'
                                          (botId and eventId are filled in and may
                                          not be supplied in the object)

environment (read by this script, never by the server):
  BO_URL      required, Bot Office base URL
  BO_TOKEN    required, this bot's token
  BO_BOT_ID   required, the slug the token is bound to
  BO_NAME     register name       (default: $BO_BOT_ID)
  BO_ROLE     register role       (default: bot)
  BO_AVATAR   register avatar     (default: robot)
  BO_POD      register pod        (default: dev)

Plain http to a host other than loopback prints a warning: the token would
travel in the clear.

Exit status is non-zero when the server answers outside 2xx.
EOF
}

die() {
  printf 'bo: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name
  for name in BO_URL BO_TOKEN BO_BOT_ID; do
    [[ -n ${!name:-} ]] || die "$name is not set"
  done
  # Tokens are base64url; anything else would also break the curl config quoting.
  [[ $BO_TOKEN =~ ^[A-Za-z0-9_-]+$ ]] || die "BO_TOKEN has unexpected characters"
  [[ $BO_BOT_ID =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "BO_BOT_ID is not a lowercase slug"
  # Plain http to a real host sends the bearer token in the clear.
  if [[ $BO_URL == http://* ]]; then
    local authority=${BO_URL#http://}
    authority=${authority%%/*}
    case $authority in
      localhost | localhost:* | 127.* | "[::1]" | "[::1]:"*) ;;
      *) printf 'bo: warning: %s is plain http, the token is sent in the clear\n' "$BO_URL" >&2 ;;
    esac
  fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Events take a ULID or a UUID; uuidgen is nicest, openssl is everywhere.
new_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'
  fi
}

# The inside of a JSON string: quotes, backslashes and every control character.
# Labels stay on one line, so newlines/tabs become their JSON escapes, not drops.
json_escape() {
  local text=$1 out='' char i code
  # Double backslashes first so the loop below only has to look at the rest.
  text=${text//\\/\\\\}
  for ((i = 0; i < ${#text}; i++)); do
    char=${text:i:1}
    case $char in
      '"') out+='\"' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      [[:cntrl:]])
        printf -v code '%04x' "'$char"
        out+="\u$code"
        ;;
      *) out+=$char ;;
    esac
  done
  printf '%s' "$out"
}

# Seconds from the last response's Retry-After, or the default when absent/HTTP-date.
retry_after() {
  local value
  value=$(sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$work/headers" | tail -n 1)
  printf '%s\n' "${value:-$DEFAULT_RETRY_SEC}"
}

# POST one JSON body; prints the response. Retries a 429 after Retry-After.
post() {
  local path=$1 body=${2-} attempt=0 status retry
  printf '%s' "$body" >"$work/body.json"
  while :; do
    status=$(
      printf 'header = "Authorization: Bearer %s"\n' "$BO_TOKEN" |
        curl -q --silent --show-error --max-time "$CURL_MAX_TIME" --config - \
          --request POST "${BO_URL%/}$path" \
          --header 'Content-Type: application/json' \
          --data-binary "@$work/body.json" \
          --dump-header "$work/headers" \
          --output "$work/response" \
          --write-out '%{http_code}'
    ) || die "could not reach $BO_URL$path"
    case $status in
      2??)
        cat "$work/response"
        printf '\n'
        return 0
        ;;
      429)
        attempt=$((attempt + 1))
        ((attempt <= MAX_RETRIES)) || die "rate limited: gave up after $MAX_RETRIES retries"
        retry=$(retry_after)
        printf 'bo: rate limited, retrying in %ss\n' "$retry" >&2
        sleep "$retry"
        ;;
      *)
        cat "$work/response" >&2
        printf '\n' >&2
        die "HTTP $status from POST $path"
        ;;
    esac
  done
}

# One event; the envelope adds botId and a fresh eventId.
send() {
  post /api/events "{\"events\":[{\"botId\":\"$BO_BOT_ID\",\"eventId\":\"$(new_id)\",$1}]}"
}

cmd_register() {
  local name=${1:-${BO_NAME:-$BO_BOT_ID}}
  local role=${2:-${BO_ROLE:-bot}}
  local avatar=${3:-${BO_AVATAR:-robot}}
  local pod=${4:-${BO_POD:-dev}}
  post /api/bots/register "$(printf '{"id":"%s","name":"%s","role":"%s","avatar":"%s","pod":"%s"}' \
    "$BO_BOT_ID" "$(json_escape "$name")" "$(json_escape "$role")" \
    "$(json_escape "$avatar")" "$(json_escape "$pod")")"
}

cmd_heartbeat() {
  local status=${1-} body='{}'
  if [[ -n $status ]]; then
    case $status in
      idle | reviewing | offline) ;;
      *) die "heartbeat status must be idle, reviewing or offline" ;;
    esac
    body=$(printf '{"status":"%s"}' "$status")
  fi
  post "/api/bots/$BO_BOT_ID/heartbeat" "$body"
}

cmd_start() {
  local label=${1-} task=${2-} extra=''
  [[ -n $label ]] || die 'start needs a label: bo start "<label>" [taskId]'
  if [[ -n $task ]]; then
    extra=",\"taskId\":\"$(json_escape "$task")\""
  fi
  send "\"type\":\"task_started\",\"label\":\"$(json_escape "$label")\"$extra"
}

cmd_done() {
  local task=${1-} result=${2:-done} extra=''
  case $result in
    done | failed | cancelled) ;;
    *) die "result must be done, failed or cancelled" ;;
  esac
  if [[ -n $task ]]; then
    extra=",\"taskId\":\"$(json_escape "$task")\""
  fi
  send "\"type\":\"task_finished\",\"result\":\"$result\"$extra"
}

cmd_handoff() {
  local to=${1-} label=${2-} task=${3-} id extra=''
  [[ -n $to && -n $label ]] || die 'handoff needs a bot and a label: bo handoff <bot> "<label>" [taskId]'
  id=$(new_id)
  if [[ -n $task ]]; then
    extra=",\"taskId\":\"$(json_escape "$task")\""
  fi
  send "\"type\":\"handoff_sent\",\"to\":\"$(json_escape "$to")\",\"handoffId\":\"$id\",\"label\":\"$(json_escape "$label")\"$extra"
  # stderr keeps stdout valid JSON while still handing the id to the caller.
  printf 'handoffId: %s\n' "$id" >&2
}

cmd_accept() {
  local id=${1-} task=${2-} extra=''
  [[ -n $id ]] || die 'accept needs a handoff id: bo accept <handoffId> [taskId]'
  if [[ -n $task ]]; then
    extra=",\"taskId\":\"$(json_escape "$task")\""
  fi
  send "\"type\":\"handoff_accepted\",\"handoffId\":\"$(json_escape "$id")\"$extra"
}

cmd_event() {
  local raw=${1-}
  [[ $raw == \{* ]] || die "event needs a JSON object, e.g. '{\"type\":\"status_changed\",\"status\":\"reviewing\"}'"
  raw=${raw#\{} # drop the opening brace, botId and eventId are added
  raw=${raw%\}} # and the closing one
  [[ -n ${raw//[[:space:]]/} ]] || die "event needs at least a type"
  # The script owns the envelope; letting the body set these would be a 403 later.
  if grep -Eq '"(botId|eventId)"[[:space:]]*:' <<<"$raw"; then
    die "event must not set botId or eventId; the script adds them"
  fi
  send "$raw"
}

main() {
  local cmd=${1-}
  if (($# > 0)); then shift; fi
  case $cmd in
    register) require_env && cmd_register "$@" ;;
    heartbeat | hb) require_env && cmd_heartbeat "$@" ;;
    start | task-start) require_env && cmd_start "$@" ;;
    done | finish | task-finish) require_env && cmd_done "$@" ;;
    handoff | handoff-send) require_env && cmd_handoff "$@" ;;
    accept | handoff-accept) require_env && cmd_accept "$@" ;;
    event) require_env && cmd_event "$@" ;;
    -h | --help | help) usage ;;
    '')
      usage >&2
      exit 2
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
