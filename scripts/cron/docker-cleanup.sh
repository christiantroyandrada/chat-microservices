#!/bin/bash
# Docker Cleanup Script - Removes unused Docker resources
# Runs weekly on Sunday at 3 AM

set -e

LOG_FILE="/var/log/chat-app/docker-cleanup.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

log "Starting Docker cleanup..."

# Get disk usage before cleanup
DISK_BEFORE=$(docker system df --format '{{.Size}}' | head -1)
log "Docker disk usage before cleanup: $DISK_BEFORE"

# Remove stopped containers (older than 24 hours)
STOPPED=$(docker ps -a -q --filter "status=exited" --filter "status=dead" 2>/dev/null | wc -l)
if [ "$STOPPED" -gt 0 ]; then
    docker container prune -f --filter "until=24h" >> "$LOG_FILE" 2>&1
    log "Removed $STOPPED stopped containers"
fi

# Remove unused images (dangling)
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l)
if [ "$DANGLING" -gt 0 ]; then
    docker image prune -f >> "$LOG_FILE" 2>&1
    log "Removed $DANGLING dangling images"
fi

# Remove unused images older than 7 days (except those in use)
docker image prune -a -f --filter "until=168h" >> "$LOG_FILE" 2>&1

# Remove unused volumes (be careful - only orphaned ones)
ORPHAN_VOLUMES=$(docker volume ls -f "dangling=true" -q 2>/dev/null | wc -l)
if [ "$ORPHAN_VOLUMES" -gt 0 ]; then
    log "Found $ORPHAN_VOLUMES orphaned volumes (not removing automatically for safety)"
fi

# Remove unused networks
docker network prune -f >> "$LOG_FILE" 2>&1

# Remove build cache older than 7 days
docker builder prune -f --filter "until=168h" >> "$LOG_FILE" 2>&1

# Get disk usage after cleanup
DISK_AFTER=$(docker system df --format '{{.Size}}' | head -1)
log "Docker disk usage after cleanup: $DISK_AFTER"

# Log Docker system overview
echo "--- Docker System Overview ---" >> "$LOG_FILE"
docker system df >> "$LOG_FILE" 2>&1

log "Docker cleanup completed"
