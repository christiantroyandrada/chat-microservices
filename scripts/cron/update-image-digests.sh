#!/bin/bash
# Update Docker Image Digests Script
# Fetches latest SHA256 digests for pinned base images and updates Dockerfiles
#
# This script helps maintain reproducible builds while staying current with
# security patches. It updates the @sha256:... references in Dockerfiles.
#
# Usage:
#   ./update-image-digests.sh           # Check for updates (dry-run)
#   ./update-image-digests.sh --apply   # Apply updates to Dockerfiles
#
# Requires: skopeo or docker with experimental manifest inspect

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}/../.."
LOG_FILE="/var/log/chat-app/digest-update.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

DRY_RUN=true
if [[ "${1:-}" == "--apply" ]]; then
    DRY_RUN=false
fi

log() {
    echo "[$TIMESTAMP] $1"
    [ -d "$(dirname "$LOG_FILE")" ] && echo "[$TIMESTAMP] $1" >> "$LOG_FILE" 2>/dev/null || true
}

# Function to get the latest digest for an image
get_latest_digest() {
    local image="$1"
    local digest=""
    
    # Try skopeo first (more reliable, doesn't require docker daemon)
    if command -v skopeo &> /dev/null; then
        digest=$(skopeo inspect --raw "docker://$image" 2>/dev/null | sha256sum | awk '{print "sha256:"$1}')
        if [ -z "$digest" ] || [ "$digest" == "sha256:" ]; then
            # Try getting manifest digest directly
            digest=$(skopeo inspect "docker://$image" 2>/dev/null | jq -r '.Digest // empty')
        fi
    fi
    
    # Fallback to docker manifest inspect
    if [ -z "$digest" ] && command -v docker &> /dev/null; then
        digest=$(docker manifest inspect "$image" 2>/dev/null | jq -r '.config.digest // .manifests[0].digest // empty')
    fi
    
    # Another fallback: crane if available
    if [ -z "$digest" ] && command -v crane &> /dev/null; then
        digest=$(crane digest "$image" 2>/dev/null)
    fi
    
    echo "$digest"
}

# Images we want to track and their Dockerfile locations
declare -A IMAGE_DOCKERFILES=(
    ["gcr.io/distroless/nodejs22-debian12:nonroot"]="chat-service/Dockerfile user-service/Dockerfile notification-service/Dockerfile ../chat-microservices-frontend/Dockerfile"
    ["bitnami/nginx"]="nginx/Dockerfile"
)

log "=========================================="
log "Docker Image Digest Update Check"
log "=========================================="
log "Mode: $([ "$DRY_RUN" = true ] && echo 'DRY-RUN (use --apply to update files)' || echo 'APPLY UPDATES')"
log ""

cd "$APP_DIR"

declare -a UPDATES_AVAILABLE=()

for image in "${!IMAGE_DOCKERFILES[@]}"; do
    log "Checking: $image"
    
    # Get latest digest from registry
    NEW_DIGEST=$(get_latest_digest "$image")
    
    if [ -z "$NEW_DIGEST" ]; then
        log "  ERROR: Could not fetch digest for $image"
        continue
    fi
    
    log "  Latest digest: $NEW_DIGEST"
    
    # Check each Dockerfile that uses this image
    IFS=' ' read -ra DOCKERFILES <<< "${IMAGE_DOCKERFILES[$image]}"
    for dockerfile in "${DOCKERFILES[@]}"; do
        if [ ! -f "$dockerfile" ]; then
            log "  File not found: $dockerfile"
            continue
        fi
        
        # Extract current digest from Dockerfile
        # Matches patterns like: image@sha256:abc123...
        image_base="${image%%:*}"  # Remove tag
        CURRENT_DIGEST=$(grep -oP "${image_base}[^@]*@\Ksha256:[a-f0-9]+" "$dockerfile" 2>/dev/null | head -1 || echo "")
        
        if [ -z "$CURRENT_DIGEST" ]; then
            log "  $dockerfile: No pinned digest found (using tag only)"
            continue
        fi
        
        if [ "$CURRENT_DIGEST" == "$NEW_DIGEST" ]; then
            log "  $dockerfile: Already up to date"
        else
            log "  $dockerfile: UPDATE AVAILABLE"
            log "    Current: $CURRENT_DIGEST"
            log "    New:     $NEW_DIGEST"
            UPDATES_AVAILABLE+=("$dockerfile")
            
            if [ "$DRY_RUN" = false ]; then
                # Update the digest in the Dockerfile
                sed -i.bak "s|${image_base}[^@]*@${CURRENT_DIGEST}|${image_base}:nonroot@${NEW_DIGEST}|g" "$dockerfile"
                rm -f "${dockerfile}.bak"
                log "  $dockerfile: UPDATED"
            fi
        fi
    done
    log ""
done

log "=========================================="
log "Summary"
log "=========================================="

if [ ${#UPDATES_AVAILABLE[@]} -eq 0 ]; then
    log "All image digests are up to date!"
else
    log "Files with available updates: ${#UPDATES_AVAILABLE[@]}"
    for f in "${UPDATES_AVAILABLE[@]}"; do
        log "  - $f"
    done
    
    if [ "$DRY_RUN" = true ]; then
        log ""
        log "To apply these updates, run:"
        log "  $0 --apply"
    else
        log ""
        log "Updates applied. Don't forget to:"
        log "  1. Review the changes: git diff"
        log "  2. Test the build: docker compose build"
        log "  3. Commit the changes: git commit -am 'chore: update base image digests'"
    fi
fi
