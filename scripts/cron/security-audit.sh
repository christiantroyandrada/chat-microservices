#!/bin/bash
# Security Audit Script - Monitors for security issues
# Runs every hour

set -e

LOG_FILE="/var/log/chat-app/security-audit.log"
ALERT_FILE="/var/log/chat-app/security-alerts.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

alert() {
    echo "[$TIMESTAMP] SECURITY ALERT: $1" >> "$ALERT_FILE"
    echo "[$TIMESTAMP] SECURITY ALERT: $1" >> "$LOG_FILE"
}

# Check for failed SSH login attempts (last hour)
FAILED_SSH=$(grep "Failed password" /var/log/auth.log 2>/dev/null | grep "$(date '+%b %e %H')" | wc -l || echo "0")
if [ "$FAILED_SSH" -gt 10 ]; then
    alert "High number of failed SSH attempts: $FAILED_SSH in the last hour"
fi

# Check for successful root logins
ROOT_LOGINS=$(grep "session opened for user root" /var/log/auth.log 2>/dev/null | grep "$(date '+%b %e')" | wc -l || echo "0")
if [ "$ROOT_LOGINS" -gt 0 ]; then
    log "Root login sessions today: $ROOT_LOGINS"
fi

# Check for new users added
NEW_USERS=$(grep "new user" /var/log/auth.log 2>/dev/null | grep "$(date '+%b %e')" | wc -l || echo "0")
if [ "$NEW_USERS" -gt 0 ]; then
    alert "New user(s) added today: $NEW_USERS"
fi

# Check for sudo usage
SUDO_USAGE=$(grep "sudo:" /var/log/auth.log 2>/dev/null | grep "$(date '+%b %e %H')" | wc -l || echo "0")
log "Sudo commands in last hour: $SUDO_USAGE"

# Check if firewall is active
if command -v ufw &> /dev/null; then
    UFW_STATUS=$(sudo ufw status | head -1)
    if [[ ! "$UFW_STATUS" =~ "active" ]]; then
        alert "UFW firewall is not active!"
    fi
fi

# Check for open ports that shouldn't be open
OPEN_PORTS=$(ss -tuln | grep LISTEN | awk '{print $5}' | grep -oE '[0-9]+$' | sort -u)
ALLOWED_PORTS="22 49152 80 443 5432 8080 8443"
for port in $OPEN_PORTS; do
    if [[ ! " $ALLOWED_PORTS " =~ " $port " ]] && [ "$port" -lt 32768 ]; then
        log "Unexpected open port detected: $port"
    fi
done

# Check Docker container security
PRIVILEGED_CONTAINERS=$(docker ps --format '{{.Names}}' | while read name; do
    if docker inspect "$name" --format '{{.HostConfig.Privileged}}' 2>/dev/null | grep -q "true"; then
        echo "$name"
    fi
done)
if [ -n "$PRIVILEGED_CONTAINERS" ]; then
    alert "Privileged containers running: $PRIVILEGED_CONTAINERS"
fi

# Check for pending security updates
SECURITY_UPDATES=$(apt list --upgradable 2>/dev/null | grep -i security | wc -l || echo "0")
if [ "$SECURITY_UPDATES" -gt 5 ]; then
    alert "Pending security updates: $SECURITY_UPDATES"
fi

# Check SSL certificate expiry
CERT_PATH="/opt/chat-app/chat-microservices/certbot/conf/live"
if [ -d "$CERT_PATH" ]; then
    for domain_dir in "$CERT_PATH"/*/; do
        if [ -f "${domain_dir}cert.pem" ]; then
            EXPIRY=$(openssl x509 -enddate -noout -in "${domain_dir}cert.pem" 2>/dev/null | cut -d= -f2)
            EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo "0")
            NOW_EPOCH=$(date +%s)
            DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
            if [ "$DAYS_LEFT" -lt 14 ]; then
                alert "SSL certificate expires in $DAYS_LEFT days!"
            fi
        fi
    done
fi

log "Security audit completed"
