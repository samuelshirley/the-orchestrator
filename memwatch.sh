#!/usr/bin/env bash
# memwatch — keeps bb (and The Orchestrator running inside it) from taking the
# Mac down. macOS has no per-process memory limit that works (ulimit -v is
# ignored), so this is a watchdog: every few seconds it measures bb's whole
# process tree — the server, every agent, and every tsc / test run / browser
# they start — logs the biggest processes, and kills the largest one in the
# tree before the Mac runs out. bb itself is spared unless it is the hog.
#
#   ./memwatch.sh           watch bb (finds it, or waits for it to start)
#   ./memwatch.sh <cmd...>  start <cmd> under the watch, e.g. ./memwatch.sh bb-app
#                           (Ctrl-C then stops both: it is the one command)
#
# Limits (override with env vars):
#   MEMWATCH_LIMIT_GB   bb's tree may use at most this much   (default: 60% of RAM)
#   MEMWATCH_MIN_FREE   act when the Mac is under this % free (default: 10)
#   MEMWATCH_INTERVAL   seconds between samples               (default: 2)
# Logs: .memwatch/ next to this script, one file per run.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$DIR/.memwatch"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/memwatch-$(date +%Y%m%d-%H%M%S).log"
SNAP="$(mktemp -t memwatch.XXXXXX)"
trap 'rm -f "$SNAP"' EXIT

INTERVAL="${MEMWATCH_INTERVAL:-2}"
MIN_FREE="${MEMWATCH_MIN_FREE:-10}"
COOLDOWN=10

total_kb() {
  if [ "$(uname)" = Darwin ]; then echo $(( $(sysctl -n hw.memsize) / 1024 ))
  else awk '/^MemTotal:/ {print $2}' /proc/meminfo; fi
}

free_pct() {
  if [ "$(uname)" = Darwin ]; then
    local level
    level="$(sysctl -n kern.memorystatus_level 2>/dev/null)"
    if [ -z "$level" ]; then level="$(memory_pressure -Q 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p')"; fi
    echo "${level:-0}"
  else
    awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%d\n", a*100/t}' /proc/meminfo
  fi
}

TOTAL_KB="$(total_kb)"
if [ -n "${MEMWATCH_LIMIT_GB:-}" ]; then
  LIMIT_KB="$(awk -v g="$MEMWATCH_LIMIT_GB" 'BEGIN {printf "%d", g*1024*1024}')"
else
  LIMIT_KB=$(( TOTAL_KB * 60 / 100 ))
fi
# The free-% trigger only fires when bb is a real share of the problem.
SHARE_KB=$(( TOTAL_KB * 25 / 100 ))

gb() { awk -v k="$1" 'BEGIN {printf "%.1f GB", k/1048576}'; }
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG" >&2; }
notify() {
  if [ "$(uname)" = Darwin ]; then
    osascript -e "display notification \"$1\" with title \"memwatch\"" >/dev/null 2>&1 || true
  fi
}

LAUNCHED=""
if [ $# -gt 0 ]; then
  "$@" &
  LAUNCHED=$!
  log "started: $* (pid $LAUNCHED)"
fi

# bb processes, by executable name only (never by arguments, so an editor or
# shell that merely mentions a bb path is not one): an executable called bb,
# BB, bb-daemon, BB Helper…, or node/bun running bb, bb-app, bb-server,
# bb-host-daemon (npx bb-app) or any script inside the bb-app package.
bb_pids() {
  ps -axo pid=,command= | awk '
    function base(p) { sub(/.*\//, "", p); return tolower(p) }
    {
      exe = base($2); arg = base($3)
      runtime = (exe == "node" || exe == "bun" || exe == "deno")
      if (exe ~ /^bb([-.]|$)/ || (runtime && (arg ~ /^bb([-.]|$)/ || $3 ~ /\/node_modules\/bb-app\//))) print $1
    }'
  # App bundles: /Applications/BB.app/Contents/MacOS/… (spaces break the fields above).
  ps -axo pid=,command= | awk 'tolower($0) ~ /^ *[0-9]+ +\/([^ ]*\/)?bb\.app\/contents\/macos\// {print $1}'
}

# Roots: the command we launched, plus every running bb process.
roots() {
  { [ -n "$LAUNCHED" ] && kill -0 "$LAUNCHED" 2>/dev/null && echo "$LAUNCHED"
    bb_pids; } | grep -v "^$$\$" | sort -u | tr '\n' ' '
}

# Prints "pid rss_kb is_root command" for every process in the roots' trees,
# biggest first.
tree() {
  ps -axo pid=,ppid=,rss=,command= > "$SNAP"
  awk -v roots="$1" '
    BEGIN { n = split(roots, r, " "); for (i = 1; i <= n; i++) { mark[r[i]] = 1; root[r[i]] = 1 } }
    {
      pid = $1; ppid[pid] = $2; rss[pid] = $3
      cmd = $0; sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ +/, "", cmd); command[pid] = substr(cmd, 1, 160)
      pids[++count] = pid
    }
    END {
      do {
        changed = 0
        for (i = 1; i <= count; i++) {
          p = pids[i]
          if (!(p in mark) && (ppid[p] in mark)) { mark[p] = 1; changed = 1 }
        }
      } while (changed)
      for (i = 1; i <= count; i++) {
        p = pids[i]
        if (p in mark) printf "%s %s %d %s\n", p, rss[p], (p in root) ? 1 : 0, command[p]
      }
    }' "$SNAP" | sort -k2,2nr
}

log "watching: limit $(gb "$LIMIT_KB") for bb's tree, act under ${MIN_FREE}% free (RAM $(gb "$TOTAL_KB")); log: $LOG"
last_kill=0
waiting_logged=0
while :; do
  if [ -n "$LAUNCHED" ] && ! kill -0 "$LAUNCHED" 2>/dev/null; then
    wait "$LAUNCHED"; code=$?
    log "$LAUNCHED exited ($code); memwatch stops."
    exit "$code"
  fi
  R="$(roots)"
  if [ -z "${R// /}" ]; then
    [ "$waiting_logged" = 1 ] || log "no bb process yet; waiting for one"
    waiting_logged=1
    sleep "$INTERVAL"; continue
  fi
  waiting_logged=0
  if [ "$R" != "${last_roots:-}" ]; then
    log "bb processes: $(for p in $R; do printf '%s(%s) ' "$p" "$(ps -o command= -p "$p" 2>/dev/null | cut -c1-60)"; done)"
    last_roots="$R"
  fi
  TREE="$(tree "$R")"
  used=$(printf '%s\n' "$TREE" | awk '{s += $2} END {print s + 0}')
  free=$(free_pct)
  top3=$(printf '%s\n' "$TREE" | head -3 | awk '{c = $4; for (i = 5; i <= NF && length(c) < 60; i++) c = c " " $i; printf "[%d %.1fG %s] ", $1, $2/1048576, c}')
  printf '%s free=%s%% bb=%s %s\n' "$(date '+%H:%M:%S')" "$free" "$(gb "$used")" "$top3" >> "$LOG"

  reason=""
  if [ "$used" -gt "$LIMIT_KB" ]; then reason="bb's tree is at $(gb "$used"), over the $(gb "$LIMIT_KB") limit"
  elif [ "$free" -lt "$MIN_FREE" ] && [ "$used" -gt "$SHARE_KB" ]; then reason="the Mac is at ${free}% free and bb's tree holds $(gb "$used")"
  fi
  now=$(date +%s)
  if [ -n "$reason" ] && [ $(( now - last_kill )) -ge "$COOLDOWN" ]; then
    # The largest non-root process; a root (bb itself) only when it is the hog.
    victim=$(printf '%s\n' "$TREE" | awk '$3 == 0 {print; exit}')
    biggest=$(printf '%s\n' "$TREE" | head -1)
    if [ -z "$victim" ] || [ "$(echo "$biggest" | awk '{print $3}')" = 1 ]; then victim="$biggest"; fi
    vpid=$(echo "$victim" | awk '{print $1}')
    vrss=$(echo "$victim" | awk '{print $2}')
    vcmd=$(echo "$victim" | cut -d' ' -f4-)
    log "LIMIT: $reason. Killing pid $vpid ($(gb "$vrss")): $vcmd"
    log "bb's tree at the time:"
    printf '%s\n' "$TREE" | head -15 | awk '{c = $4; for (i = 5; i <= NF; i++) c = c " " $i; printf "    %7d  %6.2f GB  %s\n", $1, $2/1048576, substr(c, 1, 150)}' | tee -a "$LOG" >&2
    kill -TERM "$vpid" 2>/dev/null
    sleep 3
    kill -0 "$vpid" 2>/dev/null && kill -KILL "$vpid" 2>/dev/null && log "pid $vpid ignored TERM; sent KILL"
    notify "Killed $(basename "$(echo "$vcmd" | awk '{print $1}')") ($(gb "$vrss")): $reason"
    last_kill=$(date +%s)
  fi
  sleep "$INTERVAL"
done
