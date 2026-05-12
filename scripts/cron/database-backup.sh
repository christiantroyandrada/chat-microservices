#!/bin/bash
# Database Backup Script - Creates PostgreSQL backups
# Runs daily at 2 AM

set -eo pipefail

BACKUP_DIR="/opt/chat-app/backups/postgres"
LOG_FILE="/var/log/chat-app/backup.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
RETENTION_DAYS=7
# Anything smaller than this after gzip is almost certainly a failed/empty dump
# (gzip header alone is ~20B; even a tiny real dump is multiple KB).
MIN_BACKUP_BYTES=1024

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

mkdir -p "$BACKUP_DIR"

CONTAINER_NAME="chat-microservices-postgres-1"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log "ERROR: PostgreSQL container is not running!"
    exit 1
fi

# Authoritative source of credentials is the running container. Falling back
# to docker-secrets/app_secrets is kept for historical/deploy-script parity.
DB_USER="$(docker exec "$CONTAINER_NAME" printenv POSTGRES_USER 2>/dev/null || true)"
DB_NAME="$(docker exec "$CONTAINER_NAME" printenv POSTGRES_DB 2>/dev/null || true)"

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
    SECRETS_FILE="/opt/chat-app/chat-microservices/docker-secrets/app_secrets"
    if [ -f "$SECRETS_FILE" ]; then
        set +e
        source "$SECRETS_FILE" 2>/dev/null
        set -e
    fi
    DB_USER="${DB_USER:-${ADMIN_USERNAME:-admin}}"
    DB_NAME="${DB_NAME:-chat_db}"
fi

BACKUP_FILE="$BACKUP_DIR/chat_db_backup_${TIMESTAMP}.sql.gz"
ERR_FILE="$(mktemp)"

log "Starting database backup (user=$DB_USER db=$DB_NAME)..."

# Run the dump pipeline without `set -e` so we can log the failure before exiting.
# pipefail ensures $? reflects a pg_dump failure even if gzip succeeds.
set +e
docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" "$DB_NAME" 2>"$ERR_FILE" | gzip > "$BACKUP_FILE"
PIPE_EXIT=$?
set -e

BACKUP_SIZE_BYTES=$(stat -c '%s' "$BACKUP_FILE" 2>/dev/null || echo 0)

if [ "$PIPE_EXIT" -ne 0 ] || [ "$BACKUP_SIZE_BYTES" -lt "$MIN_BACKUP_BYTES" ]; then
    log "ERROR: Backup failed (pipe_exit=$PIPE_EXIT size=${BACKUP_SIZE_BYTES}B min=${MIN_BACKUP_BYTES}B)"
    if [ -s "$ERR_FILE" ]; then
        log "pg_dump stderr: $(tr '\n' ' ' < "$ERR_FILE")"
    fi
    rm -f "$BACKUP_FILE" "$ERR_FILE"
    exit 1
fi

rm -f "$ERR_FILE"
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Backup completed successfully: $BACKUP_FILE ($BACKUP_SIZE)"

log "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "chat_db_backup_*.sql.gz" -mtime +$RETENTION_DAYS -delete

BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/chat_db_backup_*.sql.gz 2>/dev/null | wc -l)
log "Total backups: $BACKUP_COUNT"

ln -sf "$BACKUP_FILE" "$BACKUP_DIR/latest.sql.gz"

log "Database backup process completed"
