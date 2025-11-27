#!/bin/bash
set -e

echo "🚀 Starting deployment to VPS..."

# Configuration
DEPLOY_PATH="${DEPLOY_PATH:-/opt/chat-app}"

# Database credentials (from Infisical via GitHub Actions)
ADMIN_USERNAME="${ADMIN_USERNAME:-postgres}"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"
ADMIN_PASSWORD_ENCODED="${ADMIN_PASSWORD_ENCODED}"

# Application secrets (from Infisical via GitHub Actions)
CORS_ORIGINS="${CORS_ORIGINS}"
MESSAGE_BROKER_URL="${MESSAGE_BROKER_URL}"
SENDINBLUE_APIKEY="${SENDINBLUE_APIKEY}"
SMTP_PASS="${SMTP_PASS}"
SMTP_USER="${SMTP_USER}"

# Other configuration
PGADMIN_EMAIL="${PGADMIN_EMAIL:-admin@admin.com}"

# Export all environment variables for docker-compose
export ADMIN_USERNAME
export ADMIN_PASSWORD
export ADMIN_PASSWORD_ENCODED
export PGADMIN_EMAIL
export CORS_ORIGINS
export MESSAGE_BROKER_URL
export SENDINBLUE_APIKEY
export SMTP_PASS
export SMTP_USER

# Navigate to deployment directory
cd "$DEPLOY_PATH/chat-microservices"

echo "📦 Pulling latest changes..."
git fetch origin
git reset --hard origin/main

echo "🔧 Checking environment configuration..."
if [ ! -f "docker-secrets/app_secrets" ]; then
    echo "❌ Error: docker-secrets/app_secrets not found!"
    echo "Please ensure app_secrets file exists on the VPS"
    exit 1
fi

# Check if required environment variables are set
if [ -z "$ADMIN_PASSWORD" ]; then
    echo "⚠️  Warning: ADMIN_PASSWORD not set, using value from .env file if available"
fi

echo "🐳 Pulling latest Docker images..."
docker compose pull

echo "🏗️  Building backend services (excluding frontend)..."
# Build only backend services - frontend is built separately from its own repo
BACKEND_SERVICES="user-service chat-service notification-service gateway nginx"
docker compose -f docker-compose.yml -f docker-compose.prod.yml build --pull $BACKEND_SERVICES || {
  echo "⚠️ Some services failed to build. Continuing..."
}

echo "🔄 Restarting backend services..."
# Use --remove-orphans to clean up any old containers
# Use --force-recreate to ensure fresh containers
# Start backend services only (frontend is managed by its own deployment)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans $BACKEND_SERVICES || {
  echo "⚠️ Some services failed to start"
  docker compose ps
  docker compose logs --tail=50
}

echo "⏳ Waiting for services to start..."
sleep 10

echo "🧹 Cleaning up old images..."
docker image prune -f

echo "✅ Deployment completed successfully!"
echo ""
echo "📊 Service status:"
docker compose ps

echo ""
echo "🔍 Recent logs:"
docker compose logs --tail=20
