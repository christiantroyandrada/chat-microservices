#!/bin/bash
# Intrusion Detection Script - Monitors for suspicious activity
# Runs every 15 minutes

set -e

LOG_FILE="/var/log/chat-app/intrusion-detect.log"
ALERT_FILE="/var/log/chat-app/security-alerts.log"
BLOCK_FILE="/opt/chat-app/blocked-ips.txt"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

alert() {
    echo "[$TIMESTAMP] INTRUSION ALERT: $1" >> "$ALERT_FILE"
    echo "[$TIMESTAMP] INTRUSION ALERT: $1" >> "$LOG_FILE"
}

# Initialize block file if not exists
touch "$BLOCK_FILE"

log "Starting intrusion detection scan..."

# Check for brute force SSH attempts (more than 5 failed attempts from same IP in last 15 mins)
if [ -f /var/log/auth.log ]; then
    # Get failed SSH attempts in last 15 minutes
    FIFTEEN_MIN_AGO=$(date -d '15 minutes ago' '+%b %e %H:%M' 2>/dev/null || date '+%b %e %H:%M')
    
    # Extract IPs with failed attempts
    grep "Failed password" /var/log/auth.log 2>/dev/null | \
        awk '{for(i=1;i<=NF;i++) if($i=="from") print $(i+1)}' | \
        sort | uniq -c | sort -rn | while read count ip; do
        if [ "$count" -gt 5 ]; then
            # Check if already blocked
            if ! grep -q "^$ip$" "$BLOCK_FILE"; then
                alert "Brute force detected from $ip ($count failed attempts)"
                echo "$ip" >> "$BLOCK_FILE"
                
                # Block with iptables if not already blocked
                if ! sudo iptables -L INPUT -n | grep -q "$ip"; then
                    sudo iptables -A INPUT -s "$ip" -j DROP 2>/dev/null || true
                    log "Blocked IP: $ip"
                fi
            fi
        fi
    done
fi

# Check for port scanning (high number of connection attempts)
CONN_THRESHOLD=100
ss -tn 2>/dev/null | awk 'NR>1 {print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn | while read count ip; do
    if [ "$count" -gt "$CONN_THRESHOLD" ] && [ "$ip" != "127.0.0.1" ] && [ "$ip" != "::1" ]; then
        alert "Possible port scan from $ip ($count connections)"
    fi
done

# Check nginx access logs for suspicious patterns
NGINX_LOG="/opt/chat-app/chat-microservices/logs/nginx/access.log"
if [ -f "$NGINX_LOG" ]; then
    # Look for SQL injection attempts
    SQL_INJECTION=$(grep -iE "(union.*select|insert.*into|delete.*from|drop.*table|script>)" "$NGINX_LOG" 2>/dev/null | tail -5 | wc -l)
    if [ "$SQL_INJECTION" -gt 0 ]; then
        alert "Possible SQL injection attempts detected: $SQL_INJECTION"
    fi
    
    # Look for directory traversal attempts
    DIR_TRAVERSAL=$(grep -E "\.\./|\.\.%2f|%2e%2e" "$NGINX_LOG" 2>/dev/null | tail -5 | wc -l)
    if [ "$DIR_TRAVERSAL" -gt 0 ]; then
        alert "Possible directory traversal attempts detected: $DIR_TRAVERSAL"
    fi
fi

# Check for unauthorized Docker commands
if [ -f /var/log/syslog ]; then
    DOCKER_EVENTS=$(grep -i "docker" /var/log/syslog 2>/dev/null | grep "$(date '+%b %e %H')" | grep -iE "delete|remove|kill" | wc -l)
    if [ "$DOCKER_EVENTS" -gt 0 ]; then
        log "Docker modification events in last hour: $DOCKER_EVENTS"
    fi
fi

# Check for new cron jobs (potential backdoors)
CRON_HASH_FILE="/opt/chat-app/.cron_hash"
CURRENT_CRON=$(crontab -l 2>/dev/null | md5sum | cut -d' ' -f1)
if [ -f "$CRON_HASH_FILE" ]; then
    STORED_HASH=$(cat "$CRON_HASH_FILE")
    if [ "$CURRENT_CRON" != "$STORED_HASH" ]; then
        alert "Crontab has been modified!"
        echo "$CURRENT_CRON" > "$CRON_HASH_FILE"
    fi
else
    echo "$CURRENT_CRON" > "$CRON_HASH_FILE"
fi

# Count current blocked IPs
BLOCKED_COUNT=$(wc -l < "$BLOCK_FILE")
log "Intrusion detection completed. Blocked IPs: $BLOCKED_COUNT"
