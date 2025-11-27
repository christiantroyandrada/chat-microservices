#!/bin/bash
# Script to renew Let's Encrypt certificates
# Run this via cron: 0 3 * * * /opt/chat-app/chat-microservices/scripts/renew-certs.sh >> /var/log/certbot-renew.log 2>&1

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CERTBOT_PATH="$PROJECT_DIR/certbot"

echo "$(date): Starting certificate renewal check..."

# Run certbot renew
docker run --rm \
  -v "$CERTBOT_PATH/conf:/etc/letsencrypt" \
  -v "$CERTBOT_PATH/www:/var/www/certbot" \
  -v "$CERTBOT_PATH/logs:/var/log/letsencrypt" \
  certbot/certbot renew --quiet

# Fix permissions for Bitnami nginx (runs as UID 1001)
echo "$(date): Fixing certificate permissions..."
chown -R 1001:1001 "$CERTBOT_PATH" 2>/dev/null || sudo chown -R 1001:1001 "$CERTBOT_PATH"
chmod -R 755 "$CERTBOT_PATH" 2>/dev/null || sudo chmod -R 755 "$CERTBOT_PATH"

# Reload nginx to pick up new certificates (if any were renewed)
cd "$PROJECT_DIR"
docker compose exec nginx nginx -s reload 2>/dev/null || docker compose restart nginx

echo "$(date): Certificate renewal check complete"
