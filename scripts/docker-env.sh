#!/bin/bash
#
# docker-env.sh - Environment-aware Docker Compose wrapper
#
# This script automatically detects the environment and runs docker compose
# with the appropriate configuration files.
#
# Usage:
#   ./scripts/docker-env.sh up -d --build     # Auto-detect environment
#   ./scripts/docker-env.sh down              # Stop services
#   ./scripts/docker-env.sh logs -f nginx     # View logs
#   
#   DEPLOY_ENV=production ./scripts/docker-env.sh up -d  # Force production
#   DEPLOY_ENV=development ./scripts/docker-env.sh up -d # Force development
#
# Environment detection:
#   - If GITHUB_ACTIONS=true       -> production
#   - If DEPLOY_ENV=production     -> production
#   - If running on VPS (no .git)  -> production
#   - Otherwise                    -> development
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory (where docker-compose files are)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Detect environment
detect_environment() {
    # 1. Explicit override via DEPLOY_ENV
    if [ -n "$DEPLOY_ENV" ]; then
        echo "$DEPLOY_ENV"
        return
    fi
    
    # 2. GitHub Actions = production
    if [ "$GITHUB_ACTIONS" = "true" ]; then
        echo "production"
        return
    fi
    
    # 3. CI environment = production
    if [ "$CI" = "true" ]; then
        echo "production"
        return
    fi
    
    # 4. Check for SSL certificates (VPS with certs = production)
    if [ -d "./certbot/conf/live" ] && [ -n "$(ls -A ./certbot/conf/live 2>/dev/null)" ]; then
        echo "production"
        return
    fi
    
    # 5. Default to development
    echo "development"
}

ENV=$(detect_environment)

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Docker Environment Wrapper${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$ENV" = "production" ]; then
    echo -e "${GREEN}🚀 Environment: PRODUCTION${NC}"
    echo -e "${YELLOW}   - SSL/HTTPS enabled${NC}"
    echo -e "${YELLOW}   - NODE_ENV=production${NC}"
    echo -e "${YELLOW}   - Using nginx-ssl.conf${NC}"
    echo ""
    
    # Validate production requirements
    MISSING=""
    [ ! -d "./certbot/conf" ] && MISSING="${MISSING}  - Missing ./certbot/conf (SSL certificates)\n"
    [ -z "$ADMIN_USERNAME" ] && [ ! -f "./docker-secrets/app_secrets" ] && MISSING="${MISSING}  - Missing ADMIN_USERNAME or docker-secrets/app_secrets\n"
    
    if [ -n "$MISSING" ]; then
        echo -e "${RED}⚠️  Production requirements not met:${NC}"
        echo -e "${RED}${MISSING}${NC}"
        echo -e "${YELLOW}Run init-letsencrypt.sh first or set up secrets.${NC}"
        # Don't exit - let docker compose fail with proper error
    fi
    
    COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
else
    echo -e "${GREEN}🔧 Environment: DEVELOPMENT${NC}"
    echo -e "${YELLOW}   - HTTP only (no SSL)${NC}"
    echo -e "${YELLOW}   - NODE_ENV=development${NC}"
    echo -e "${YELLOW}   - Using nginx.conf${NC}"
    echo ""
    
    COMPOSE_CMD="docker compose"
fi

echo -e "${BLUE}Command: ${COMPOSE_CMD} $@${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Run docker compose with appropriate config
exec $COMPOSE_CMD "$@"
