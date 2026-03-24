#!/usr/bin/env bash
# Deploy Scuffy to a fresh Linode VPS.
# Run as root. Assumes Ubuntu/Debian.
set -euo pipefail

APP_USER="scuffy"
APP_DIR="/opt/scuffy"
DOMAIN="scuffy.foramerica.dev"
REPO="https://github.com/gjw/scuffy.git"

echo "--- Installing system dependencies ---"
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx git

# Install Node 24 via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi

echo "--- Creating app user and directory ---"
id -u "$APP_USER" &>/dev/null || useradd -r -m -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"

echo "--- Cloning repo ---"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "--- Installing npm dependencies ---"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "--- Setting up .env ---"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ANTHROPIC_API_KEY=your-key-here" > "$APP_DIR/.env"
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "!!! Edit /opt/scuffy/.env with your real ANTHROPIC_API_KEY !!!"
fi

echo "--- Installing systemd service ---"
cp "$APP_DIR/deploy/scuffy.service" /etc/systemd/system/scuffy.service
systemctl daemon-reload
systemctl enable scuffy

echo "--- Setting up nginx ---"
cp "$APP_DIR/deploy/scuffy.nginx.conf" /etc/nginx/sites-available/scuffy
ln -sf /etc/nginx/sites-available/scuffy /etc/nginx/sites-enabled/scuffy
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "--- Obtaining TLS certificate ---"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@foramerica.dev

echo "--- Starting Scuffy ---"
systemctl start scuffy

echo ""
echo "Done. Scuffy should be live at https://$DOMAIN"
echo "Check status: systemctl status scuffy"
echo "View logs:    journalctl -u scuffy -f"
