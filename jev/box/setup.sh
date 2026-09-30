#!/usr/bin/env bash
# jev/box/setup.sh: run once on a fresh Verda box by `jev up` (ssh root@ip bash
# /root/jev/setup.sh). Reads /root/verda.env (0600, scp'd; never on a command
# line): JEV_SERVER, JEV_MODEL, JEV_HOST, JEV_KEY_ORCHESTRATOR,
# JEV_KEY_APP, VERDA_CLIENT_ID, VERDA_CLIENT_SECRET, INSTANCE_ID,
# OS_VOLUME_ID, IDLE_MINUTES, MAX_LIFETIME_HOURS.
#
# Order matters: the self-deleting watchdog goes in FIRST, so a setup that
# hangs still ends in a delete. Every install line here is UNVERIFIED on a
# real box (jev/README.md).
set -euo pipefail
umask 022

ENV_FILE=/root/verda.env
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -r "$ENV_FILE" ] || { echo "setup: $ENV_FILE missing" >&2; exit 1; }
chmod 600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
for v in JEV_SERVER JEV_HOST JEV_KEY_ORCHESTRATOR JEV_KEY_APP VERDA_CLIENT_ID VERDA_CLIENT_SECRET INSTANCE_ID OS_VOLUME_ID; do
  [ -n "${!v:-}" ] || { echo "setup: $v missing from $ENV_FILE" >&2; exit 1; }
done
SETUP_GRACE_MIN="${SETUP_GRACE_MIN:-45}"
export DEBIAN_FRONTEND=noninteractive

step() { echo "== $*"; }

# ---------------------------------------------------------------- watchdog first
step "watchdog (every minute; deletes this instance when idle ${IDLE_MINUTES:-15} min or at ${MAX_LIFETIME_HOURS:-4} h)"
apt-get update -qq
apt-get install -y -qq curl jq ufw debian-keyring debian-archive-keyring apt-transport-https gnupg python3-venv >/dev/null
mkdir -p /var/lib/jev /opt/jev
# Idle counts from here during setup, with a grace; the lifetime cap still counts from boot.
echo $(( $(date +%s) + SETUP_GRACE_MIN * 60 )) > /var/lib/jev/ready_at
install -m 0700 "$HERE/watchdog.sh" /opt/jev/watchdog.sh
cat > /etc/systemd/system/jev-watchdog.service <<'UNIT'
[Unit]
Description=Jev idle/lifetime watchdog (deletes this Verda instance)

[Service]
Type=oneshot
ExecStart=/opt/jev/watchdog.sh
UNIT
cat > /etc/systemd/system/jev-watchdog.timer <<'UNIT'
[Unit]
Description=Run the Jev watchdog every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now jev-watchdog.timer

# ---------------------------------------------------------------- firewall
step "ufw: 22, 80, 443 only"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- model server
step "model server: $JEV_SERVER"
python3 -m venv /opt/jev/venv
/opt/jev/venv/bin/pip install -q -U pip
case "$JEV_SERVER" in
  anyjev)
    /opt/jev/venv/bin/pip install -q "anyjev[hf] @ git+https://github.com/nokia-applied-research/AnyJev@45add301a7aa60ed3420c83d15c061e84e5bce61" fastapi "uvicorn[standard]"
    install -m 0644 "$HERE/anyjev_shim.py" /opt/jev/anyjev_shim.py
    EXEC="/opt/jev/venv/bin/uvicorn anyjev_shim:app --app-dir /opt/jev --host 127.0.0.1 --port 8765"
    MODEL_ENV="JEV_HF_MODEL=Qwen/Qwen3-8B"
    ;;
  laya)
    # UNVERIFIED: the package and command names of the Laya typed-decisions server.
    /opt/jev/venv/bin/pip install -q "${LAYA_PIP:-laya-typed-decisions}"
    EXEC="/opt/jev/venv/bin/${LAYA_SERVE:-laya-serve} --host 127.0.0.1 --port 8765"
    MODEL_ENV="JEV_MODEL=${JEV_MODEL:-laya-421m}"
    ;;
  *) echo "setup: unknown JEV_SERVER $JEV_SERVER" >&2; exit 1 ;;
esac
cat > /etc/systemd/system/jev-model.service <<UNIT
[Unit]
Description=Jev typed-decision server ($JEV_SERVER) on 127.0.0.1:8765
After=network-online.target

[Service]
Environment=HF_HOME=/opt/jev/hf
Environment=$MODEL_ENV
ExecStart=$EXEC
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now jev-model.service

# ---------------------------------------------------------------- caddy
step "caddy (TLS for $JEV_HOST)"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy >/dev/null
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
install -m 0644 "$HERE/Caddyfile.tmpl" /etc/caddy/Caddyfile
( umask 077; printf "JEV_HOST='%s'\nJEV_KEY_ORCHESTRATOR='%s'\nJEV_KEY_APP='%s'\n" \
    "$JEV_HOST" "$JEV_KEY_ORCHESTRATOR" "$JEV_KEY_APP" > /etc/caddy/jev.env )
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/jev.conf <<'UNIT'
[Service]
EnvironmentFile=/etc/caddy/jev.env
UNIT
systemctl daemon-reload
systemctl restart caddy

# ---------------------------------------------------------------- ready
step "waiting for the model server to load (up to 40 min)"
for _ in $(seq 1 480); do
  if curl -sf -m 5 http://127.0.0.1:8765/healthz >/dev/null 2>&1; then
    date +%s > /var/lib/jev/ready_at
    step "ready"
    exit 0
  fi
  sleep 5
done
echo "setup: the model server never answered /healthz" >&2
journalctl -u jev-model --no-pager -n 40 >&2 || true
exit 1
