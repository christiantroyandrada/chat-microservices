#!/bin/bash
# Docker Image Rebuild Script - Rebuilds images with latest secure base images
# Runs weekly on Saturday at 2 AM (before Sunday cleanup)
#
# This script:
# 1. Checks if base images have security updates
# 2. Fetches latest SHA digests for pinned images
# 3. Optionally rebuilds and redeploys containers
#
# Security Note: Rebuilding regularly ensures OS-level security patches
# are applied even when application code hasn't changed.

set -euo pipefail

LOG_FILE="/var/log/chat-app/docker-rebuild.log"
ALERT_FILE="/var/log/chat-app/alerts.log"
APP_DIR="/opt/chat-app/chat-microservices"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Configuration
AUTO_REBUILD=${AUTO_REBUILD:-false}  # Set to 'true' to auto-rebuild
AUTO_DEPLOY=${AUTO_DEPLOY:-false}    # Set to 'true' to auto-deploy after rebuild
NOTIFY_ONLY=${NOTIFY_ONLY:-true}     # Just notify about available updates

log() {
    echo "[$TIMESTAMP] $1" | tee -a "$LOG_FILE"
}

alert() {
    echo "[$TIMESTAMP] REBUILD: $1" >> "$ALERT_FILE"
    log "ALERT: $1"
}

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

log "=========================================="
log "Starting Docker image security check..."
log "=========================================="

# Check if we're on the VPS with docker
if ! command -v docker &> /dev/null; then
    log "Docker not found. Skipping rebuild check."
    exit 0
fi

cd "$APP_DIR" 2>/dev/null || {
    log "App directory not found: $APP_DIR"
    exit 0
}

# Arrays to track updates
declare -a IMAGES_WITH_UPDATES=()
declare -a CURRENT_DIGESTS=()
declare -a NEW_DIGESTS=()

# Function to get remote image digest
get_remote_digest() {
    local image="$1"
    # Use docker manifest inspect or skopeo if available
    if command -v skopeo &> /dev/null; then
        skopeo inspect "docker://$image" 2>/dev/null | jq -r '.Digest' || echo ""
    else
        # Fallback to docker manifest
        docker manifest inspect "$image" 2>/dev/null | jq -r '.config.digest // .manifests[0].digest' || echo ""
    fi
}

# Function to get local image digest
get_local_digest() {
    local image="$1"
    docker images --digests --format '{{.Digest}}' "$image" 2>/dev/null | head -1 || echo ""
}

# Base images to check for updates
# Format: "image:tag" or "image@sha256:..." 
declare -a BASE_IMAGES=(
    "node:22-bookworm-slim"
    "gcr.io/distroless/nodejs22-debian12:nonroot"
    "bitnami/nginx:latest"
    "postgres:17.6-trixie"
)

log "Checking ${#BASE_IMAGES[@]} base images for updates..."

for image in "${BASE_IMAGES[@]}"; do
    log "Checking: $image"
    
    # Pull latest manifest info (doesn't download layers)
    LOCAL_DIGEST=$(get_local_digest "$image")
    
    # Try to get remote digest
    REMOTE_DIGEST=$(get_remote_digest "$image")
    
    if [ -n "$REMOTE_DIGEST" ] && [ -n "$LOCAL_DIGEST" ]; then
        if [ "$LOCAL_DIGEST" != "$REMOTE_DIGEST" ]; then
            log "  UPDATE AVAILABLE: $image"
            log "    Local:  $LOCAL_DIGEST"
            log "    Remote: $REMOTE_DIGEST"
            IMAGES_WITH_UPDATES+=("$image")
            CURRENT_DIGESTS+=("$LOCAL_DIGEST")
            NEW_DIGESTS+=("$REMOTE_DIGEST")
        else
            log "  Up to date: $image"
        fi
    elif [ -z "$LOCAL_DIGEST" ]; then
        log "  Image not pulled locally: $image"
    else
        log "  Could not check remote: $image (network issue or rate limit)"
    fi
done

# Report findings
log ""
log "=========================================="
log "Security Check Results"
log "=========================================="

if [ ${#IMAGES_WITH_UPDATES[@]} -eq 0 ]; then
    log "All base images are up to date. No rebuild needed."
    exit 0
fi

log "Found ${#IMAGES_WITH_UPDATES[@]} image(s) with updates:"
for i in "${!IMAGES_WITH_UPDATES[@]}"; do
    log "  - ${IMAGES_WITH_UPDATES[$i]}"
done

alert "Docker base image updates available: ${#IMAGES_WITH_UPDATES[@]} images"

# If notify only mode, stop here
if [ "$NOTIFY_ONLY" = "true" ]; then
    log ""
    log "NOTIFY_ONLY mode: Not rebuilding automatically."
    log "To rebuild manually, run:"
    log "  cd $APP_DIR && docker compose build --no-cache --pull"
    exit 0
fi

# Auto-rebuild if enabled
if [ "$AUTO_REBUILD" = "true" ]; then
    log ""
    log "AUTO_REBUILD enabled. Starting rebuild..."
    
    # Pull latest base images
    log "Pulling latest base images..."
    for image in "${IMAGES_WITH_UPDATES[@]}"; do
        docker pull "$image" >> "$LOG_FILE" 2>&1 || log "Failed to pull: $image"
    done
    
    # Rebuild all services with no cache to ensure fresh base
    log "Rebuilding services..."
    if docker compose build --no-cache --pull >> "$LOG_FILE" 2>&1; then
        log "Rebuild completed successfully."
        alert "Docker images rebuilt with latest security patches"
        
        # Auto-deploy if enabled
        if [ "$AUTO_DEPLOY" = "true" ]; then
            log "AUTO_DEPLOY enabled. Restarting services..."
            
            # Rolling restart to minimize downtime
            for service in user chat notification frontend nginx; do
                log "Restarting $service..."
                docker compose up -d --no-deps "$service" >> "$LOG_FILE" 2>&1 || log "Failed to restart: $service"
                sleep 10  # Wait for service to be healthy
            done
            
            log "All services restarted."
            alert "Services redeployed with updated images"
        else
            log "AUTO_DEPLOY disabled. Services not restarted."
            log "To deploy manually, run:"
            log "  cd $APP_DIR && docker compose up -d"
        fi
    else
        log "ERROR: Rebuild failed!"
        alert "Docker rebuild FAILED - manual intervention required"
        exit 1
    fi
fi

log ""
log "Docker security check completed."
