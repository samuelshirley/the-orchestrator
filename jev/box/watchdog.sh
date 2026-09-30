#!/usr/bin/env bash
# jev/box/watchdog.sh: run every minute on the Jev box by jev-watchdog.timer.
# The same rule as jev/policy.ts watchdogDecision (watchdog.test.ts checks
# they agree): delete-lifetime at MAX_LIFETIME_HOURS since boot; delete-idle
# after IDLE_MINUTES since the last authenticated request (the mtime of
# Caddy's jev.log), or with none yet since boot or since setup finished. On a
# delete it DELETES ITS OWN INSTANCE through the Verda API, so a crashed
# laptop can never leave it running.
#
# Test hooks: NOW_S, BOOT_S, LAST_S, READY_S override the clock and the
# readings (set but empty = none); DRY=1 prints only the decision word.
set -uo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-15}"
MAX_LIFETIME_HOURS="${MAX_LIFETIME_HOURS:-4}"
ENV_FILE="${JEV_ENV_FILE:-/root/verda.env}"
ACCESS_LOG="${JEV_ACCESS_LOG:-/var/log/caddy/jev.log}"
READY_FILE="${JEV_READY_FILE:-/var/lib/jev/ready_at}"
WATCHDOG_LOG="${JEV_WATCHDOG_LOG:-/var/log/jev-watchdog.log}"
API="https://api.verda.com/v1"

if [ "${DRY:-0}" != "1" ] && [ -r "$ENV_FILE" ]; then
  # Exported (set -a) so jq's env.* reads them; nothing here echoes them.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  IDLE_MINUTES="${IDLE_MINUTES:-15}"
  MAX_LIFETIME_HOURS="${MAX_LIFETIME_HOURS:-4}"
fi

NOW_S="${NOW_S:-$(date +%s)}"
if [ -z "${BOOT_S+x}" ]; then
  read -r up _ < /proc/uptime
  BOOT_S=$(( NOW_S - ${up%%.*} ))
fi
if [ -z "${LAST_S+x}" ]; then
  LAST_S=""
  [ -f "$ACCESS_LOG" ] && LAST_S="$(stat -c %Y "$ACCESS_LOG" 2>/dev/null || true)"
fi
if [ -z "${READY_S+x}" ]; then
  READY_S=""
  [ -f "$READY_FILE" ] && READY_S="$(tr -dc 0-9 < "$READY_FILE")"
fi

decide() {
  local since="$BOOT_S"
  if [ $(( NOW_S - BOOT_S )) -ge $(( MAX_LIFETIME_HOURS * 3600 )) ]; then echo delete-lifetime; return; fi
  if [ -n "$READY_S" ] && [ "$READY_S" -gt "$since" ]; then since="$READY_S"; fi
  if [ -n "$LAST_S" ] && [ "$LAST_S" -gt "$since" ]; then since="$LAST_S"; fi
  if [ $(( NOW_S - since )) -ge $(( IDLE_MINUTES * 60 )) ]; then echo delete-idle; return; fi
  echo keep
}

DECISION="$(decide)"
if [ "${DRY:-0}" = "1" ]; then echo "$DECISION"; exit 0; fi
[ "$DECISION" = "keep" ] && exit 0

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$WATCHDOG_LOG"; }
log "$DECISION: deleting instance ${INSTANCE_ID:-?} (boot $BOOT_S, last request ${LAST_S:-none}, ready ${READY_S:-?})"

# Secrets go to curl on stdin, never argv; the token goes in a 0600 header file.
umask 077
HDR="$(mktemp)"
trap 'rm -f "$HDR"' EXIT
TOKEN="$(jq -nc '{grant_type:"client_credentials",client_id:env.VERDA_CLIENT_ID,client_secret:env.VERDA_CLIENT_SECRET}' \
  | curl -sS -m 30 -X POST -H 'Content-Type: application/json' -H 'User-Agent: jev-watchdog/1.0' --data-binary @- "$API/oauth2/token" \
  | jq -r '.access_token // empty')"
if [ -z "$TOKEN" ]; then log "token request failed; the next run tries again"; exit 1; fi
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"
STATUS="$(jq -nc '{action:"delete",id:env.INSTANCE_ID,volume_ids:[env.OS_VOLUME_ID],delete_permanently:true}' \
  | curl -sS -m 30 -o /dev/null -w '%{http_code}' -X PUT -H @"$HDR" -H 'Content-Type: application/json' \
      -H 'User-Agent: jev-watchdog/1.0' --data-binary @- "$API/instances")"
log "delete asked: HTTP $STATUS (202/204 accepted, 404 already gone); the next run asks again if the box is still here"
