#!/bin/bash
# Helper script to create environment variables on VPS

echo "🔐 Creating environment variables..."

# Prompt for required values
read -p "Enter PostgreSQL admin username [postgres]: " ADMIN_USERNAME
ADMIN_USERNAME=${ADMIN_USERNAME:-postgres}

read -sp "Enter PostgreSQL admin password: " ADMIN_PASSWORD
echo

read -p "Enter pgAdmin email [admin@admin.com]: " PGADMIN_EMAIL
PGADMIN_EMAIL=${PGADMIN_EMAIL:-admin@admin.com}

# Create .env file in the chat-microservices directory
DEPLOY_PATH="${DEPLOY_PATH:-/opt/chat-app}"
ENV_FILE="$DEPLOY_PATH/chat-microservices/.env"

cat > "$ENV_FILE" << ENVEOF
# Database Configuration
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD

# pgAdmin Configuration
PGADMIN_EMAIL=$PGADMIN_EMAIL
ENVEOF

chmod 600 "$ENV_FILE"

echo "✅ Environment file created at: $ENV_FILE"
echo "🔒 File permissions set to 600 (owner read/write only)"
echo ""
echo "⚠️  Make sure to also configure your app_secrets file:"
echo "   $DEPLOY_PATH/chat-microservices/docker-secrets/app_secrets"
