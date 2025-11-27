#!/bin/bash
# Script to initialize Let's Encrypt certificates for the first time
# This should be run ONCE on the VPS to obtain initial certificates
#
# Prerequisites:
#   - Services must already be running (deploy-vps.sh completed)
#   - Domain must point to this server's IP
#   - Ports 80 and 443 must be accessible
#
# Usage:
#   STAGING=1 ./scripts/init-letsencrypt.sh   # Test with staging certs first
#   STAGING=0 ./scripts/init-letsencrypt.sh   # Get production certs

set -e

# Configuration
DOMAIN="${DOMAIN:-chat.ctaprojects.xyz}"
EMAIL="${EMAIL:-admin@ctaprojects.xyz}"
STAGING="${STAGING:-0}"

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CERTBOT_PATH="$PROJECT_DIR/certbot"
NGINX_SSL_TEMPLATE="$PROJECT_DIR/nginx/ssl/nginx-ssl.conf"
NGINX_CONF="$PROJECT_DIR/nginx/nginx.conf"
SECRETS_FILE="$PROJECT_DIR/docker-secrets/app_secrets"

echo "🔐 Initializing Let's Encrypt SSL for $DOMAIN"
echo "📧 Email: $EMAIL"
echo "🧪 Staging: $STAGING"
echo ""

# Load secrets from app_secrets if they exist (needed for docker compose)
if [ -f "$SECRETS_FILE" ]; then
  echo "📦 Loading secrets from app_secrets..."
  set -a
  source "$SECRETS_FILE"
  set +a
  echo "✅ Secrets loaded"
else
  echo "⚠️  No app_secrets file found at $SECRETS_FILE"
  echo "   Make sure ADMIN_USERNAME and ADMIN_PASSWORD are set in environment"
fi

# Verify required env vars
if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "❌ ADMIN_USERNAME and ADMIN_PASSWORD must be set"
  echo "   Either run deploy-vps.sh first, or source app_secrets manually:"
  echo "   source docker-secrets/app_secrets"
  exit 1
fi

# Create directories
echo "📁 Creating certbot directories..."
mkdir -p "$CERTBOT_PATH/conf"
mkdir -p "$CERTBOT_PATH/www"
mkdir -p "$CERTBOT_PATH/logs"

# Check if certificates already exist
if [ -d "$CERTBOT_PATH/conf/live/$DOMAIN" ]; then
  echo "⚠️  Certificates already exist for $DOMAIN"
  echo "   To renew: ./scripts/renew-certs.sh"
  echo "   To force new certs: rm -rf $CERTBOT_PATH/conf/live/$DOMAIN"
  exit 0
fi

# Backup current nginx config
if [ -f "$NGINX_CONF" ]; then
  cp "$NGINX_CONF" "$NGINX_CONF.backup"
  echo "📋 Backed up nginx.conf to nginx.conf.backup"
fi

# Create temporary nginx config for ACME challenge (HTTP only)
echo "📝 Creating temporary nginx config for ACME challenge..."
cat > "$NGINX_CONF" << TEMPCONF
events {}

http {
  resolver 127.0.0.11 valid=30s ipv6=off;

  server {
    listen 8080;
    server_name $DOMAIN www.$DOMAIN;

    # Let's Encrypt ACME challenge - this is what certbot needs
    location /.well-known/acme-challenge/ {
      root /var/www/certbot;
      allow all;
    }

    # Return simple response for other requests during setup
    location / {
      return 200 '{"status":"ok","message":"SSL setup in progress..."}';
      add_header Content-Type application/json;
    }
  }
}
TEMPCONF

echo "✅ Temporary nginx config created"

# Create a temporary docker-compose override to mount certbot www volume
# This is needed because the base compose doesn't have the volume (to not affect local dev)
TEMP_COMPOSE="$PROJECT_DIR/docker-compose.acme.yml"
cat > "$TEMP_COMPOSE" << ACMECOMPOSE
# Temporary override for ACME challenge - mounts certbot www directory
services:
  nginx:
    volumes:
      - ./certbot/www:/var/www/certbot:ro
ACMECOMPOSE

echo "📄 Created temporary compose override for ACME challenge"

# Rebuild and restart ONLY nginx (no dependencies)
echo "🔄 Rebuilding nginx container..."
cd "$PROJECT_DIR"

# Use --no-deps to avoid restarting other services
docker compose stop nginx 2>/dev/null || true
docker compose build nginx
docker compose -f docker-compose.yml -f "$TEMP_COMPOSE" up -d --no-deps nginx

echo "⏳ Waiting for nginx to be ready..."
sleep 5

# Verify nginx is responding
echo "🔍 Testing nginx..."
if curl -sf "http://localhost:80/health" > /dev/null 2>&1; then
  echo "✅ Nginx is responding on port 80"
elif curl -sf "http://127.0.0.1:80/" > /dev/null 2>&1; then
  echo "✅ Nginx is responding on port 80"
else
  echo "⚠️  Nginx might not be ready, but continuing..."
  docker compose logs nginx --tail=10 || true
fi

# Create a test file for ACME challenge verification
mkdir -p "$CERTBOT_PATH/www/.well-known/acme-challenge"
echo "test-ok" > "$CERTBOT_PATH/www/.well-known/acme-challenge/test-file"

# Determine staging flag
STAGING_ARG=""
if [ "$STAGING" = "1" ]; then
  STAGING_ARG="--staging"
  echo ""
  echo "🧪 Using Let's Encrypt STAGING environment (test certificates)"
  echo "   These certs are NOT trusted by browsers but won't hit rate limits"
fi

# Request certificate using certbot
echo ""
echo "🔐 Requesting SSL certificate from Let's Encrypt..."
echo "   Domain: $DOMAIN"
echo "   Email: $EMAIL"
echo ""

docker run --rm \
  -v "$CERTBOT_PATH/conf:/etc/letsencrypt" \
  -v "$CERTBOT_PATH/www:/var/www/certbot" \
  -v "$CERTBOT_PATH/logs:/var/log/letsencrypt" \
  certbot/certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    --keep-until-expiring \
    --non-interactive \
    $STAGING_ARG \
    -d "$DOMAIN"

# Find the certificate directory (may have suffix like -0001 if renewed)
CERT_DIR=$(find "$CERTBOT_PATH/conf/live" -maxdepth 1 -type d -name "${DOMAIN}*" | head -1)

# Check if certificate was obtained
if [ -z "$CERT_DIR" ] || [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  echo ""
  echo "❌ Failed to obtain certificate!"
  echo ""
  echo "Troubleshooting steps:"
  echo "  1. Check DNS: dig $DOMAIN"
  echo "  2. Check port 80 is open: curl http://$DOMAIN/.well-known/acme-challenge/test-file"
  echo "  3. Check logs: cat $CERTBOT_PATH/logs/letsencrypt.log"
  echo ""
  echo "Restoring original nginx config..."
  if [ -f "$NGINX_CONF.backup" ]; then
    mv "$NGINX_CONF.backup" "$NGINX_CONF"
    docker compose up -d --no-deps nginx
  fi
  rm -f "$TEMP_COMPOSE"
  exit 1
fi

# Get the actual cert directory name (e.g., chat.ctaprojects.xyz or chat.ctaprojects.xyz-0001)
CERT_NAME=$(basename "$CERT_DIR")
echo ""
echo "✅ Certificate obtained successfully!"
echo "   Certificate directory: $CERT_NAME"
echo ""

# Fix permissions for Bitnami nginx (runs as UID 1001)
echo "🔐 Fixing certificate permissions for nginx..."
sudo chown -R 1001:1001 "$CERTBOT_PATH" 2>/dev/null || chown -R 1001:1001 "$CERTBOT_PATH"
sudo chmod -R 755 "$CERTBOT_PATH" 2>/dev/null || chmod -R 755 "$CERTBOT_PATH"
echo "✅ Permissions fixed"

# Now switch to SSL nginx config
echo "📝 Switching to SSL-enabled nginx config..."
if [ -f "$NGINX_SSL_TEMPLATE" ]; then
  # Replace both placeholders:
  # - DOMAIN_PLACEHOLDER for server_name
  # - CERT_DIR_PLACEHOLDER for certificate paths (may have -0001 suffix)
  sed -e "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" \
      -e "s/CERT_DIR_PLACEHOLDER/$CERT_NAME/g" \
      "$NGINX_SSL_TEMPLATE" > "$NGINX_CONF"
  echo "✅ SSL nginx config created (cert dir: $CERT_NAME)"
else
  echo "❌ SSL template not found at $NGINX_SSL_TEMPLATE"
  echo "   Restoring original config..."
  if [ -f "$NGINX_CONF.backup" ]; then
    mv "$NGINX_CONF.backup" "$NGINX_CONF"
  fi
  exit 1
fi

# Rebuild nginx with SSL config
echo "�� Rebuilding nginx with SSL support..."
docker compose stop nginx
docker compose build nginx

# Start nginx with SSL
# Need to use prod compose file to mount certificate volumes
echo "🚀 Starting nginx with SSL certificates..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps nginx

echo "⏳ Waiting for nginx to start with SSL..."
sleep 5

# Test HTTPS
echo "🔍 Testing HTTPS..."
if curl -sk "https://localhost:443/health" 2>/dev/null | grep -q "ok"; then
  echo "✅ HTTPS is working locally!"
else
  echo "⚠️  Local HTTPS test inconclusive (may need external test)"
fi

# Clean up
rm -f "$NGINX_CONF.backup"
rm -f "$CERTBOT_PATH/www/.well-known/acme-challenge/test-file"
rm -f "$TEMP_COMPOSE"

echo ""
echo "🎉 ============================================="
echo "   SSL Setup Complete!"
echo "   ============================================="
echo ""
echo "Your site should now be accessible at:"
echo "  🔒 https://$DOMAIN"
echo ""
echo "Test it:"
echo "  curl https://$DOMAIN/health"
echo ""
if [ "$STAGING" = "1" ]; then
  echo "⚠️  You used STAGING certificates (not browser-trusted)"
  echo "   To get real certificates, run again with:"
  echo "   rm -rf $CERTBOT_PATH/conf/live/$DOMAIN"
  echo "   STAGING=0 ./scripts/init-letsencrypt.sh"
  echo ""
fi
echo "Next steps:"
echo "  1. Set up auto-renewal: sudo crontab -e"
echo "     Add: 0 3 * * * $PROJECT_DIR/scripts/renew-certs.sh >> /var/log/certbot-renew.log 2>&1"
echo ""
