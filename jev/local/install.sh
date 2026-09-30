#!/usr/bin/env bash
# Jev on the owner's Mac: install, start, stop and remove the launchd job that runs
# jev/local/serve_local.py on 127.0.0.1:8766 (CPU only).
#
# This script never runs the server itself. Only launchd starts it, so the
# process is launchd's child: it is not a descendant of The Orchestrator's
# agents and carries no BB_THREAD_ID, which keeps it outside the agent tree
# budget (the memory guard would otherwise kill a 1.5 GB process).
#
#   jev/local/install.sh install [--at-login|--manual]   (default --manual)
#   jev/local/install.sh start | stop | status | uninstall
#   jev/local/install.sh render [--at-login|--manual]    prints the plist, writes nothing
set -euo pipefail

LABEL="com.theorchestrator.jev-local"
PORT=8766
BASE_URL="http://127.0.0.1:${PORT}"
MODEL="typed-decisions"
MIN_FREE_MEMORY_PERCENT=30
MIN_FREE_DISK_GB=5

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RUNTIME="${JEV_RUNTIME:-$HOME/.bb/thread-storage/jev-ai/runtime}"
# The runtime's own env.sh is the reference for HF_HOME.
HF="${JEV_HF_HOME:-$RUNTIME/hf}"
CONFIG_DIR="$HOME/.config/jev"
LOCAL_JSON="$CONFIG_DIR/local.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

die() {
  echo "jev-local: $*" >&2
  exit 1
}

usage() {
  sed -n '10,12p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 2
}

run_at_load() {
  case "${1:---manual}" in
    --at-login) echo true ;;
    --manual) echo false ;;
    *) usage ;;
  esac
}

render() {
  local at_load="$1" path
  for path in "$RUNTIME" "$REPO" "$HF" "$HOME"; do
    case "$path" in
      *[\&\<\>\|]*) die "the path $path has a character a plist cannot hold (& < > |)." ;;
    esac
  done
  sed \
    -e "s|__RUNTIME__|$RUNTIME|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__HF_HOME__|$HF|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__RUN_AT_LOAD__|$at_load|g" \
    "$HERE/$LABEL.plist.tmpl"
}

check_room() {
  local memory disk
  memory="$(memory_pressure | awk '/free percentage/{print $5+0}')"
  [ -n "$memory" ] || die "could not read free memory from memory_pressure."
  [ "$memory" -ge "$MIN_FREE_MEMORY_PERCENT" ] || die "free memory is ${memory}%, under ${MIN_FREE_MEMORY_PERCENT}%. Close something and try again."
  disk="$(df -g "$HOME" | awk 'NR==2{print $4+0}')"
  [ -n "$disk" ] || die "could not read free disk from df."
  [ "$disk" -ge "$MIN_FREE_DISK_GB" ] || die "free disk is ${disk} GB, under ${MIN_FREE_DISK_GB} GB."
  echo "jev-local: free memory ${memory}%, free disk ${disk} GB."
}

install() {
  local at_load
  at_load="$(run_at_load "${1:-}")"
  # The plist names this checkout's serve_local.py; a task worktree is removed when its task closes.
  case "$REPO" in
    */.claude/worktrees/*) die "run this from the main checkout, not a task worktree ($REPO)." ;;
  esac
  [ -x "$RUNTIME/venv/bin/python" ] || die "no $RUNTIME/venv/bin/python. Set JEV_RUNTIME to the laya runtime directory."
  check_room
  (umask 077 && mkdir -p "$CONFIG_DIR")
  chmod 700 "$CONFIG_DIR"
  mkdir -p "$(dirname "$PLIST")"
  # A job already loaded under this label is replaced.
  launchctl bootout "$SERVICE" 2>/dev/null || true
  render "$at_load" >"$PLIST"
  chmod 644 "$PLIST"
  launchctl bootstrap "$DOMAIN" "$PLIST"
  (umask 077 && printf '{"baseUrl":"%s","model":"%s"}\n' "$BASE_URL" "$MODEL" >"$LOCAL_JSON")
  chmod 600 "$LOCAL_JSON"
  if [ "$at_load" = true ]; then
    echo "jev-local: installed; launchd starts it now and at each login."
  else
    echo "jev-local: installed, not started. Run: jev/local/install.sh start"
  fi
}

start() {
  [ -f "$PLIST" ] || die "not installed. Run: jev/local/install.sh install"
  launchctl kickstart "$SERVICE"
  echo "jev-local: started by launchd. The model takes a while to load; check: jev/local/install.sh status"
}

stop() {
  launchctl kill TERM "$SERVICE"
  echo "jev-local: stopped."
}

status() {
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    launchctl print "$SERVICE" | grep -E '^[[:space:]]*(state|pid|runs|last exit code) =' || true
  else
    echo "jev-local: not loaded in launchd."
  fi
  if [ -f "$LOCAL_JSON" ]; then echo "local.json: present"; else echo "local.json: missing (The Orchestrator does not ask)"; fi
  printf 'health: '
  curl -s -m 2 "$BASE_URL/health" || printf 'no answer on %s' "$BASE_URL"
  echo
}

uninstall() {
  launchctl bootout "$SERVICE" 2>/dev/null || true
  rm -f "$PLIST" "$LOCAL_JSON"
  echo "jev-local: removed the launchd job and local.json. The runtime and local.log are left alone."
}

case "${1:-}" in
  install) install "${2:-}" ;;
  render) render "$(run_at_load "${2:-}")" ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  uninstall) uninstall ;;
  *) usage ;;
esac
