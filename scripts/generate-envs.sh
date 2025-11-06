#!/usr/bin/env bash
# Generate per-service .env files from consolidated docker-secrets/app_secrets
# Usage: from repo root, run: ./scripts/generate-envs.sh [--force]
#   --force: Overwrite existing .env files

set -euo pipefail

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_FILE="$ROOT_DIR/docker-secrets/app_secrets"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Secrets file not found: $SECRETS_FILE"
  echo "Copy docker-secrets/app_secrets.example to docker-secrets/app_secrets and populate it first."
  exit 1
fi

get_value() {
  local key="$1"
  grep "^${key}=" "$SECRETS_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

write_env() {
  local dest="$1"
  if [ -f "$dest" ] && [ "$FORCE" = "false" ]; then
    echo "Skipping $dest (already exists)"
    return
  fi
  if [ -f "$dest" ]; then
    echo "Overwriting $dest (--force enabled)"
  else
    echo "Creating $dest"
  fi
  : > "$dest"
  
  case "$dest" in
    */user-service/.env)
      echo "NODE_ENV=\"$(get_value NODE_ENV)\"" >> "$dest"
      echo "PORT=\"$(get_value PORT_USER)\"" >> "$dest"
      echo "JWT_SECRET=\"$(get_value JWT_SECRET_USER)\"" >> "$dest"
      echo "MONGO_URI=\"$(get_value MONGO_URI_USER)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      ;;
    */chat-service/.env)
      echo "NODE_ENV=\"$(get_value NODE_ENV)\"" >> "$dest"
      echo "PORT=\"$(get_value PORT_CHAT)\"" >> "$dest"
      echo "JWT_SECRET=\"$(get_value JWT_SECRET_CHAT)\"" >> "$dest"
      echo "MONGO_URI=\"$(get_value MONGO_URI_CHAT)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      echo "CORS_ORIGINS=\"$(get_value CORS_ORIGINS)\"" >> "$dest"
      ;;
    */notification-service/.env)
      echo "NODE_ENV=\"$(get_value NODE_ENV)\"" >> "$dest"
      echo "PORT=\"$(get_value PORT_NOTIFICATION)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      echo "SMTP_HOST=\"$(get_value SMTP_HOST)\"" >> "$dest"
      echo "SMTP_PORT=\"$(get_value SMTP_PORT)\"" >> "$dest"
      echo "SMTP_USER=\"$(get_value SMTP_USER)\"" >> "$dest"
      echo "SMTP_PASS=\"$(get_value SMTP_PASS)\"" >> "$dest"
      echo "SENDINBLUE_APIKEY=\"$(get_value SENDINBLUE_APIKEY)\"" >> "$dest"
      echo "EMAIL_FROM=\"$(get_value EMAIL_FROM)\"" >> "$dest"
      echo "NOTIFICATIONS_QUEUE=\"$(get_value NOTIFICATIONS_QUEUE)\"" >> "$dest"
      ;;
    *)
      # Root .env for docker-compose.yml variable substitution
      echo "ADMIN_USERNAME=\"$(get_value ADMIN_USERNAME)\"" >> "$dest"
      echo "ADMIN_PASSWORD=\"$(get_value ADMIN_PASSWORD)\"" >> "$dest"
      echo "ADMIN_PASSWORD_ENCODED=\"$(get_value ADMIN_PASSWORD_ENCODED)\"" >> "$dest"
      ;;
  esac
  
  chmod 600 "$dest" 2>/dev/null || true
}

write_env "$ROOT_DIR/.env"
write_env "$ROOT_DIR/user-service/.env"
write_env "$ROOT_DIR/chat-service/.env"
write_env "$ROOT_DIR/notification-service/.env"

echo ""
if [ "$FORCE" = "true" ]; then
  echo "Done. Generated/overwritten .env files."
else
  echo "Done. Generated .env files where they did not already exist."
  echo "Run with --force to overwrite existing files."
fi
