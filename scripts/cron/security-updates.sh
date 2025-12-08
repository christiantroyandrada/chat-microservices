#!/bin/bash
# Security Updates Script - Checks and optionally applies security updates
# Runs daily at 5 AM

set -e

LOG_FILE="/var/log/chat-app/security-updates.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

log "Starting security update check..."

# Update package lists
apt-get update -qq >> "$LOG_FILE" 2>&1

# Check for security updates
SECURITY_UPDATES=$(apt list --upgradable 2>/dev/null | grep -i security | wc -l)
ALL_UPDATES=$(apt list --upgradable 2>/dev/null | grep -v "Listing" | wc -l)

log "Available updates: $ALL_UPDATES (Security: $SECURITY_UPDATES)"

# Log pending updates
if [ "$ALL_UPDATES" -gt 0 ]; then
    echo "--- Pending Updates ---" >> "$LOG_FILE"
    apt list --upgradable 2>/dev/null >> "$LOG_FILE"
fi

# Auto-apply unattended security updates if enabled
if [ -f /etc/apt/apt.conf.d/50unattended-upgrades ]; then
    log "Unattended upgrades is configured"
    # Trigger unattended-upgrade if there are security updates
    if [ "$SECURITY_UPDATES" -gt 0 ]; then
        log "Triggering unattended-upgrade for security updates..."
        unattended-upgrade -d >> "$LOG_FILE" 2>&1 || log "Unattended-upgrade completed with warnings"
    fi
else
    log "Note: Unattended upgrades not configured. Consider enabling for automatic security patches."
fi

# Check for kernel updates that require reboot
if [ -f /var/run/reboot-required ]; then
    log "NOTICE: System reboot required for kernel updates!"
    echo "[$TIMESTAMP] REBOOT REQUIRED" >> /var/log/chat-app/alerts.log
fi

# Check Docker images for updates
log "Checking Docker images for security updates..."
cd /opt/chat-app/chat-microservices 2>/dev/null || exit 0

# Check if base images have updates
for image in postgres:17.6-trixie node:22-bullseye-slim nginx:latest; do
    LOCAL_ID=$(docker images --format '{{.ID}}' "$image" 2>/dev/null | head -1)
    if [ -n "$LOCAL_ID" ]; then
        # Pull to check for updates (doesn't replace running containers)
        docker pull "$image" -q >> "$LOG_FILE" 2>&1 || true
        NEW_ID=$(docker images --format '{{.ID}}' "$image" 2>/dev/null | head -1)
        if [ "$LOCAL_ID" != "$NEW_ID" ]; then
            log "Docker image update available: $image"
        fi
    fi
done

log "Security update check completed"
