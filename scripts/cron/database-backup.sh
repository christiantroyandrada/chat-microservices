#!/bin/bash
# Database Backup Script - Creates PostgreSQL backups
# Runs daily at 2 AM

set -e

BACKUP_DIR="/opt/chat-app/backups/postgres"
LOG_FILE="/var/log/chat-app/backup.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
RETENTION_DAYS=7

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Get database credentials from docker-secrets
SECRETS_FILE="/opt/chat-app/chat-microservices/docker-secrets/app_secrets"
if [ -f "$SECRETS_FILE" ]; then
    set +e
    source "$SECRETS_FILE" 2>/dev/null
    set -e
fi

# Default values if not set
DB_USER="${ADMIN_USERNAME:-postgres}"
DB_NAME="chat_db"
CONTAINER_NAME="chat-microservices-postgres-1"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log "ERROR: PostgreSQL container is not running!"
    exit 1
fi

# Create backup
BACKUP_FILE="$BACKUP_DIR/chat_db_backup_${TIMESTAMP}.sql.gz"
log "Starting database backup..."

# Use docker exec for the backup - this is the reliable method
docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_FILE"

if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "Backup completed successfully: $BACKUP_FILE ($BACKUP_SIZE)"
else
    log "ERROR: Backup file is empty or not created!"
    exit 1
fi

# Remove old backups (older than retention period)
log "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "chat_db_backup_*.sql.gz" -mtime +$RETENTION_DAYS -delete

# Count remaining backups
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/chat_db_backup_*.sql.gz 2>/dev/null | wc -l)
log "Total backups: $BACKUP_COUNT"

# Create a latest symlink
ln -sf "$BACKUP_FILE" "$BACKUP_DIR/latest.sql.gz"

log "Database backup process completed"
