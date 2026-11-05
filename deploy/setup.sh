#!/usr/bin/env bash
# One-time setup of Wamon on a fresh Ubuntu 22.04/24.04 server (Oracle Cloud Always Free works well).
#
#   curl -fsSL https://raw.githubusercontent.com/lorangutan/whatsapp-admin-dashboard/main/deploy/setup.sh -o setup.sh
#   sudo bash setup.sh wamon.example.my.id
#
# Installs Node 22 + Caddy, clones the app to /opt/wamon, asks for the secrets (they stay on this server),
# and starts Wamon as a systemd service behind Caddy with automatic HTTPS for the domain you pass.
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash setup.sh your-domain.example}"
REPO_URL="${REPO_URL:-https://github.com/lorangutan/whatsapp-admin-dashboard.git}"
APP_DIR=/opt/wamon
DATA_DIR=/var/lib/wamon
ENV_FILE=/etc/wamon.env

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> Firewall: allow HTTP/HTTPS"
# Oracle's Ubuntu images ship iptables rules that only allow SSH, even when the VCN security list is open.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null

echo "==> App user and code"
id wamon >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin wamon
mkdir -p "$DATA_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chown -R wamon:wamon "$APP_DIR" "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Secrets (typed here, stored only in $ENV_FILE)"
  read -rp  "TiDB DATABASE_URL (mysql://user:pass@host:4000/wamon): " DATABASE_URL
  read -rsp "Dashboard password: " ADMIN_PASSWORD; echo
  read -rp  "Shop name [Toko Saya]: " SHOP_NAME
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=true
DATA_DIR=$DATA_DIR
SHOP_NAME=${SHOP_NAME:-Toko Saya}
DATABASE_URL=$DATABASE_URL
ADMIN_PASSWORD=$ADMIN_PASSWORD
SESSION_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
fi

echo "==> Service"
install -m 644 "$APP_DIR/deploy/wamon.service" /etc/systemd/system/wamon.service
systemctl daemon-reload
systemctl enable --now wamon
systemctl restart wamon

echo "==> Caddy (HTTPS for $DOMAIN)"
sed "s/{\$WAMON_DOMAIN}/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

sleep 3
if systemctl is-active --quiet wamon; then
  echo
  echo "Wamon is running: https://$DOMAIN"
  echo "Logs:   journalctl -u wamon -f"
  echo "Update: sudo bash $APP_DIR/deploy/update.sh"
else
  echo "Wamon failed to start. Check: journalctl -u wamon -n 50"
  exit 1
fi
