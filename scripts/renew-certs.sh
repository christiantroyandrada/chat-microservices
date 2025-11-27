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

# Reload nginx to pick up new certificates (if any were renewed)
cd "$PROJECT_DIR"
docker compose exec nginx nginx -s reload 2>/dev/null || docker compose restart nginx

echo "$(date): Certificate renewal check complete"
