#!/bin/bash
# Script to initialize Let's Encrypt certificates for the first time
# This should be run ONCE on the VPS to obtain initial certificates

set -e

# Configuration - CHANGE THESE
DOMAIN="${DOMAIN:-chat.ctaprojects.xyz}"
EMAIL="${EMAIL:-admin@ctaprojects.xyz}"  # Your email for Let's Encrypt notifications
STAGING="${STAGING:-0}"  # Set to 1 for testing to avoid rate limits

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CERTBOT_PATH="$PROJECT_DIR/certbot"
NGINX_SSL_TEMPLATE="$PROJECT_DIR/nginx/ssl/nginx-ssl.conf"
NGINX_CONF="$PROJECT_DIR/nginx/nginx.conf"

echo "🔐 Initializing Let's Encrypt SSL for $DOMAIN"
echo "📧 Email: $EMAIL"
echo "🧪 Staging: $STAGING"

# Create directories
mkdir -p "$CERTBOT_PATH/conf"
mkdir -p "$CERTBOT_PATH/www"
mkdir -p "$CERTBOT_PATH/logs"

# Check if certificates already exist
if [ -d "$CERTBOT_PATH/conf/live/$DOMAIN" ]; then
  echo "⚠️  Certificates already exist for $DOMAIN"
  echo "   If you want to renew, use: docker compose run --rm certbot renew"
  echo "   If you want to force new certs, delete: $CERTBOT_PATH/conf/live/$DOMAIN"
  exit 0
fi

# Create initial nginx config for ACME challenge (HTTP only, no SSL yet)
echo "📝 Creating temporary nginx config for ACME challenge..."
cat > "$NGINX_CONF" << 'TEMPCONF'
events {}

http {
  resolver 127.0.0.11 valid=30s ipv6=off;

  upstream user {
    zone user 64k;
    server user:8081 resolve;
    keepalive 16;
  }

  upstream chat {
    zone chat 64k;
    server chat:8082 resolve;
    keepalive 16;
  }

  upstream notification {
    zone notification 64k;
    server notification:8083 resolve;
    keepalive 16;
  }

  server {
    listen 8080;
TEMPCONF

echo "    server_name $DOMAIN www.$DOMAIN;" >> "$NGINX_CONF"

cat >> "$NGINX_CONF" << 'TEMPCONF2'

    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
      root /var/www/certbot;
      allow all;
    }

    # Temporary: proxy to services while getting cert
    location /health {
      return 200 '{"status":"ok","message":"Setting up SSL..."}';
      add_header Content-Type application/json;
    }

    location /api/user/ {
      proxy_pass http://user/;
    }

    location /user/ {
      proxy_pass http://user/;
    }

    location /chat/ {
      proxy_pass http://chat/;
    }

    location /notification/ {
      proxy_pass http://notification/notifications/;
    }

    location /notifications/ {
      proxy_pass http://notification/notifications/;
    }

    location / {
      return 200 '{"status":"setting_up_ssl","message":"SSL certificate is being configured..."}';
      add_header Content-Type application/json;
    }
  }
}
TEMPCONF2

echo "✅ Temporary nginx config created"

# Rebuild nginx with new config
echo "🔄 Rebuilding nginx container..."
cd "$PROJECT_DIR"

# Stop nginx if running
docker compose stop nginx 2>/dev/null || true

# Rebuild and start nginx
docker compose build nginx
docker compose up -d nginx

echo "⏳ Waiting for nginx to be ready..."
sleep 5

# Test that nginx is responding
if curl -s "http://localhost:80/.well-known/acme-challenge/test" > /dev/null 2>&1 || curl -s "http://localhost:80/health" > /dev/null 2>&1; then
  echo "✅ Nginx is responding"
else
  echo "⚠️  Nginx might not be ready yet, continuing anyway..."
fi

# Determine staging flag
STAGING_ARG=""
if [ "$STAGING" = "1" ]; then
  STAGING_ARG="--staging"
  echo "🧪 Using Let's Encrypt STAGING environment (test certificates)"
fi

# Request certificate using certbot
echo "🔐 Requesting SSL certificate from Let's Encrypt..."
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
    $STAGING_ARG \
    -d "$DOMAIN"

# Check if certificate was obtained
if [ ! -f "$CERTBOT_PATH/conf/live/$DOMAIN/fullchain.pem" ]; then
  echo "❌ Failed to obtain certificate!"
  echo "📝 Check logs: $CERTBOT_PATH/logs/"
  exit 1
fi

echo "✅ Certificate obtained successfully!"

# Now switch to SSL nginx config
echo "📝 Switching to SSL-enabled nginx config..."
if [ -f "$NGINX_SSL_TEMPLATE" ]; then
  sed "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" "$NGINX_SSL_TEMPLATE" > "$NGINX_CONF"
  echo "✅ SSL nginx config created"
else
  echo "❌ SSL template not found at $NGINX_SSL_TEMPLATE"
  exit 1
fi

# Rebuild nginx with SSL config
echo "🔄 Rebuilding nginx with SSL..."
docker compose stop nginx
docker compose build nginx
docker compose up -d nginx

echo "⏳ Waiting for nginx to start with SSL..."
sleep 5

# Test HTTPS
if curl -sk "https://localhost:443/health" > /dev/null 2>&1 || curl -sk "https://$DOMAIN/health" > /dev/null 2>&1; then
  echo "✅ HTTPS is working!"
else
  echo "⚠️  HTTPS test couldn't connect, but certificates are installed"
  echo "   Try: curl -k https://$DOMAIN/health"
fi

echo ""
echo "🎉 SSL Setup Complete!"
echo ""
echo "Your site should now be accessible at:"
echo "  🔒 https://$DOMAIN"
echo ""
echo "Next steps:"
echo "  1. Test your site: curl -k https://$DOMAIN/health"
echo "  2. Set up automatic renewal (see renew-certs.sh)"
echo "  3. If using staging certs, re-run with STAGING=0 for production certs"
echo ""
