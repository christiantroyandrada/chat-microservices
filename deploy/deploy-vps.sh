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
if ! cd "$DEPLOY_PATH/chat-microservices" 2>/dev/null; then
  echo "❌ Cannot change directory to $DEPLOY_PATH/chat-microservices"
  echo "Please ensure the CI created or cloned the repository into the deploy path"
  exit 2
fi

echo "📦 Pulling latest changes..."
git fetch origin || echo "⚠️ git fetch failed (continuing)"
git reset --hard origin/main || echo "⚠️ git reset failed (continuing)"

echo "🔧 Checking environment configuration..."
  echo "🔧 Ensuring docker-secrets/app_secrets exists (will write from CI-provided envs if present)..."
  mkdir -p docker-secrets

  # If ADMIN_PASSWORD is provided in the environment, overwrite/create the app_secrets file
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    echo "➡️ Writing docker-secrets/app_secrets from environment variables"
    cat > docker-secrets/app_secrets <<EOF
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_PASSWORD_ENCODED=${ADMIN_PASSWORD_ENCODED}
CORS_ORIGINS=${CORS_ORIGINS}
MESSAGE_BROKER_URL=${MESSAGE_BROKER_URL}
SENDINBLUE_APIKEY=${SENDINBLUE_APIKEY}
SMTP_PASS=${SMTP_PASS}
SMTP_USER=${SMTP_USER}
PGADMIN_EMAIL=${PGADMIN_EMAIL}
EOF
    chmod 600 docker-secrets/app_secrets || true
    echo "✅ Wrote docker-secrets/app_secrets"
  else
    # If no ADMIN_PASSWORD in env and file missing, fail because setup cannot run
    if [ ! -f docker-secrets/app_secrets ]; then
      echo "❌ docker-secrets/app_secrets not found and no secrets provided in environment"
      echo "Please provide secrets via Infisical in CI or place app_secrets on the VPS"
      exit 1
    else
      echo "ℹ️ docker-secrets/app_secrets exists on disk — using existing file"
    fi
  fi

# Check if required environment variables are set
if [ -z "$ADMIN_PASSWORD" ]; then
    echo "⚠️  Warning: ADMIN_PASSWORD not set, using value from .env file if available"
fi


# Ensure docker is installed and accessible
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker CLI is not installed or not in PATH"
  exit 3
fi

if ! docker ps >/dev/null 2>&1; then
  echo "❌ Cannot communicate with the Docker daemon (permission denied or daemon down)"
  echo "💡 To allow the deploy user to use Docker without sudo on the VPS, run:" 
  echo "   sudo usermod -aG docker $USER && newgrp docker"
  exit 4
fi

echo "🐳 Determining docker-compose files..."
COMPOSE_ARGS=()
if [ -f docker-compose.yml ]; then
  COMPOSE_ARGS+=( -f docker-compose.yml )
fi
if [ -f docker-compose.prod.yml ]; then
  COMPOSE_ARGS+=( -f docker-compose.prod.yml )
fi

if [ ${#COMPOSE_ARGS[@]} -eq 0 ]; then
  echo "❌ No docker-compose files found (docker-compose.yml or docker-compose.prod.yml)"
  exit 5
fi

echo "🐳 Pulling latest Docker images..."
docker compose "${COMPOSE_ARGS[@]}" pull || echo "⚠️ docker compose pull failed (continuing)"

echo "🏗️  Building backend services (excluding frontend)..."
# Build only backend services - frontend is built separately from its own repo
# Note: service names in compose are 'user', 'chat', 'notification' (not '*-service')
# setup service uses a pre-built node image, so no build needed
BACKEND_SERVICES=(user chat notification nginx)
docker compose "${COMPOSE_ARGS[@]}" build --pull "${BACKEND_SERVICES[@]}" || {
  echo "⚠️ Some services failed to build. Continuing..."
}

echo "🔄 Running setup service to generate .env files (synchronous)..."
# Run setup synchronously to ensure .env files are generated before starting DB/services
docker compose "${COMPOSE_ARGS[@]}" run --rm setup || {
  echo "❌ Setup service failed to run. See logs below:"
  docker compose "${COMPOSE_ARGS[@]}" logs setup --tail=200 || true
  exit 7
}

echo "✅ Setup completed. Starting database and backend services..."
docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans --force-recreate postgres pgadmin "${BACKEND_SERVICES[@]}" || {
  echo "⚠️ Some services failed to start"
  docker compose "${COMPOSE_ARGS[@]}" ps || true
  docker compose "${COMPOSE_ARGS[@]}" logs --tail=50 || true
}

# Verify that expected .env files were created by setup
MISSING_ENV=0
for svc in user-service chat-service notification-service; do
  if [ ! -f "$svc/.env" ]; then
    echo "❌ Missing generated env file: $svc/.env"
    MISSING_ENV=1
  fi
done
if [ "$MISSING_ENV" -eq 1 ]; then
  echo "📝 Showing setup logs to help diagnose missing .env files..."
  docker compose "${COMPOSE_ARGS[@]}" logs setup --tail=200 || true
  echo "❌ One or more generated .env files are missing after setup. Aborting."
  exit 8
fi

echo "⏳ Waiting for services to start..."

# Wait for health endpoint to return success with timeout
HEALTH_URL="http://localhost:80/health"
TIMEOUT=120
INTERVAL=5
ELAPSED=0
echo "🔍 Waiting up to ${TIMEOUT}s for ${HEALTH_URL} to respond..."
until curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "❌ Health check did not become ready within ${TIMEOUT}s"
    echo "📋 Service status:"
    docker compose "${COMPOSE_ARGS[@]}" ps || true
    echo "📝 Recent logs:" 
    docker compose "${COMPOSE_ARGS[@]}" logs --tail=100 || true
    exit 6
  fi
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo "🧹 Cleaning up old images..."
docker image prune -f || true

echo "✅ Deployment completed successfully!"
echo ""
echo "📊 Service status:"
docker compose "${COMPOSE_ARGS[@]}" ps || true

echo ""
echo "🔍 Recent logs:"
docker compose "${COMPOSE_ARGS[@]}" logs --tail=20 || true
