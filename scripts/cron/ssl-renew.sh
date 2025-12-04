#!/bin/bash
# SSL Certificate Renewal Script
# Runs twice daily at 3 AM and 3 PM

set -e

LOG_FILE="/var/log/chat-app/ssl-renew.log"
PROJECT_DIR="/opt/chat-app/chat-microservices"
CERTBOT_PATH="$PROJECT_DIR/certbot"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

log "Starting SSL certificate renewal check..."

# Check if certbot directory exists
if [ ! -d "$CERTBOT_PATH/conf" ]; then
    log "Certbot configuration not found. Skipping renewal."
    exit 0
fi

# Check certificate expiry
CERT_PATH="$CERTBOT_PATH/conf/live"
for domain_dir in "$CERT_PATH"/*/; do
    if [ -f "${domain_dir}cert.pem" ]; then
        DOMAIN=$(basename "$domain_dir")
        EXPIRY=$(openssl x509 -enddate -noout -in "${domain_dir}cert.pem" 2>/dev/null | cut -d= -f2)
        EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo "0")
        NOW_EPOCH=$(date +%s)
        DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
        
        log "Certificate for $DOMAIN expires in $DAYS_LEFT days"
        
        if [ "$DAYS_LEFT" -lt 30 ]; then
            log "Certificate needs renewal (less than 30 days remaining)"
        fi
    fi
done

# Run certbot renewal
log "Running certbot renewal..."
docker run --rm \
    -v "$CERTBOT_PATH/conf:/etc/letsencrypt" \
    -v "$CERTBOT_PATH/www:/var/www/certbot" \
    -v "$CERTBOT_PATH/logs:/var/log/letsencrypt" \
    certbot/certbot renew --quiet >> "$LOG_FILE" 2>&1 || {
        log "Certbot renewal check completed (may have nothing to renew)"
    }

# Fix permissions for nginx (runs as UID 1001)
log "Fixing certificate permissions..."
sudo chown -R 1001:1001 "$CERTBOT_PATH" 2>/dev/null || true
chmod -R 755 "$CERTBOT_PATH" 2>/dev/null || true

# Reload nginx to pick up new certificates
cd "$PROJECT_DIR"
if docker compose ps nginx | grep -q "Up"; then
    docker compose exec -T nginx nginx -s reload 2>/dev/null || {
        log "Restarting nginx to apply certificate changes..."
        docker compose restart nginx >> "$LOG_FILE" 2>&1
    }
    log "Nginx reloaded successfully"
fi

log "SSL renewal check completed"
