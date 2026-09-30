#!/bin/sh
# npm start: dependencies, bb running, the plugin built and installed, the app open.
set -e
cd "$(dirname "$0")"

# bb is pinned here and fetched by npx, so nothing is installed globally and a
# new bb release cannot break the plugin. Raise it with `bb plugin types`.
BB_VERSION=0.44.0
bbcli() { npx -y -p "bb-app@$BB_VERSION" bb "$@"; }

npm install --include=dev --ignore-scripts

if ! bbcli plugin list >/dev/null 2>&1; then
  log="${TMPDIR:-/tmp}/bb-app.log"
  echo "Starting bb (log: $log)"
  nohup npx -y "bb-app@$BB_VERSION" >"$log" 2>&1 &
  until bbcli plugin list >/dev/null 2>&1; do
    sleep 1
  done
fi

bbcli plugin build
bbcli plugin install "$PWD" --yes

state=$(bbcli plugin list | grep -A1 '^the-orchestrator@' || true)
case "$state" in
  *" running"*) ;;
  *)
    echo "$state" >&2
    exit 1
    ;;
esac

url=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.bb/bb-app-runtime.json", "utf8")).serverUrl)')
echo "The Orchestrator is running: $url/plugins/the-orchestrator/board"
open "$url/plugins/the-orchestrator/board"
