#!/usr/bin/env bash
# Pull the latest code and restart. Linked WhatsApp numbers reconnect by themselves.
#   sudo bash /opt/wamon/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/wamon

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
git -C "$APP_DIR" pull --ff-only
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chown -R wamon:wamon "$APP_DIR"
install -m 644 "$APP_DIR/deploy/wamon.service" /etc/systemd/system/wamon.service
systemctl daemon-reload
systemctl restart wamon
sleep 3
systemctl is-active --quiet wamon && echo "Updated and running." || { journalctl -u wamon -n 40; exit 1; }
