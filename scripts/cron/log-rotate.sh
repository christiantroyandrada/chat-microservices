#!/bin/bash
# Log Rotation Script - Rotates and compresses application logs
# Runs daily at 4 AM

set -e

LOG_DIR="/var/log/chat-app"
RETENTION_DAYS=30
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1"
}

log "Starting log rotation..."

# Rotate logs in /var/log/chat-app
for logfile in "$LOG_DIR"/*.log; do
    if [ -f "$logfile" ] && [ -s "$logfile" ]; then
        # Get file size in KB
        SIZE=$(du -k "$logfile" | cut -f1)
        
        # Rotate if larger than 10MB
        if [ "$SIZE" -gt 10240 ]; then
            BASENAME=$(basename "$logfile" .log)
            DATE_SUFFIX=$(date '+%Y%m%d_%H%M%S')
            ROTATED_FILE="${LOG_DIR}/${BASENAME}_${DATE_SUFFIX}.log.gz"
            
            # Compress and rotate
            gzip -c "$logfile" > "$ROTATED_FILE"
            
            # Truncate original file (don't delete to avoid breaking file handles)
            : > "$logfile"
            
            log "Rotated: $logfile -> $ROTATED_FILE"
        fi
    fi
done

# Remove old rotated logs
find "$LOG_DIR" -name "*.log.gz" -mtime +$RETENTION_DAYS -delete

# Rotate Docker container logs
PROJECT_DIR="/opt/chat-app/chat-microservices"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# Truncate Docker JSON logs if they're too large (> 100MB)
for container_id in $(docker ps -q 2>/dev/null); do
    LOG_PATH=$(docker inspect --format='{{.LogPath}}' "$container_id" 2>/dev/null)
    if [ -f "$LOG_PATH" ]; then
        SIZE=$(du -m "$LOG_PATH" 2>/dev/null | cut -f1)
        if [ "$SIZE" -gt 100 ]; then
            log "Warning: Container log $LOG_PATH is ${SIZE}MB - Docker log driver should handle rotation"
        fi
    fi
done

log "Log rotation completed"
