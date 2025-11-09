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

generate_jwt_secret() {
  # Generate a cryptographically secure 64-byte random secret
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 64 | tr -d '\n'
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
  else
    echo "ERROR: Neither openssl nor node found. Cannot generate JWT secret." >&2
    exit 1
  fi
}

ensure_jwt_secrets() {
  local needs_update=false
  local weak_secrets=("{{YOUR_SECRET_KEY}}" "CHANGEME" "changeme" "test" "secret")
  
  # Check for a shared JWT_SECRET (all services use the same secret)
  local key="JWT_SECRET"
  local current_value
  current_value=$(get_value "$key")
  
  # Check if JWT secret is missing, empty, or weak
  local is_weak=false
  if [ -z "$current_value" ] || [ ${#current_value} -lt 32 ]; then
    is_weak=true
  else
    for weak in "${weak_secrets[@]}"; do
      if [ "$current_value" = "$weak" ]; then
        is_weak=true
        break
      fi
    done
  fi
  
  if [ "$is_weak" = true ]; then
    echo "Generating strong shared JWT secret..."
    local new_secret
    new_secret=$(generate_jwt_secret)
    # Update the secrets file
    if grep -q "^${key}=" "$SECRETS_FILE"; then
      # Replace existing line (macOS and Linux compatible)
      if sed --version >/dev/null 2>&1; then
        # GNU sed
        sed -i "s|^${key}=.*|${key}=${new_secret}|" "$SECRETS_FILE"
      else
        # BSD sed (macOS)
        sed -i '' "s|^${key}=.*|${key}=${new_secret}|" "$SECRETS_FILE"
      fi
    else
      # Append if not found
      echo "${key}=${new_secret}" >> "$SECRETS_FILE"
    fi
    needs_update=true
  fi
  
  if [ "$needs_update" = true ]; then
    echo "✓ Updated app_secrets with strong shared JWT secret"
    echo ""
  fi
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
      echo "JWT_SECRET=\"$(get_value JWT_SECRET)\"" >> "$dest"
      echo "MONGO_URI=\"$(get_value MONGO_URI_USER)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      echo "CORS_ORIGINS=\"$(get_value CORS_ORIGINS)\"" >> "$dest"
      ;;
    */chat-service/.env)
      echo "NODE_ENV=\"$(get_value NODE_ENV)\"" >> "$dest"
      echo "PORT=\"$(get_value PORT_CHAT)\"" >> "$dest"
      echo "JWT_SECRET=\"$(get_value JWT_SECRET)\"" >> "$dest"
      echo "MONGO_URI=\"$(get_value MONGO_URI_CHAT)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      echo "CORS_ORIGINS=\"$(get_value CORS_ORIGINS)\"" >> "$dest"
      ;;
    */notification-service/.env)
      echo "NODE_ENV=\"$(get_value NODE_ENV)\"" >> "$dest"
      echo "PORT=\"$(get_value PORT_NOTIFICATION)\"" >> "$dest"
      echo "JWT_SECRET=\"$(get_value JWT_SECRET)\"" >> "$dest"
      echo "MESSAGE_BROKER_URL=\"$(get_value MESSAGE_BROKER_URL)\"" >> "$dest"
      echo "SMTP_HOST=\"$(get_value SMTP_HOST)\"" >> "$dest"
      echo "SMTP_PORT=\"$(get_value SMTP_PORT)\"" >> "$dest"
      echo "SMTP_USER=\"$(get_value SMTP_USER)\"" >> "$dest"
      echo "SMTP_PASS=\"$(get_value SMTP_PASS)\"" >> "$dest"
      echo "SENDINBLUE_APIKEY=\"$(get_value SENDINBLUE_APIKEY)\"" >> "$dest"
      echo "EMAIL_FROM=\"$(get_value EMAIL_FROM)\"" >> "$dest"
      echo "NOTIFICATIONS_QUEUE=\"$(get_value NOTIFICATIONS_QUEUE)\"" >> "$dest"
      echo "CORS_ORIGINS=\"$(get_value CORS_ORIGINS)\"" >> "$dest"
      ;;
    *)
      # Root .env for docker-compose.yml variable substitution
      echo "ADMIN_USERNAME=\"$(get_value ADMIN_USERNAME)\"" >> "$dest"
      echo "ADMIN_PASSWORD=\"$(get_value ADMIN_PASSWORD)\"" >> "$dest"
      echo "ADMIN_PASSWORD_ENCODED=\"$(get_value ADMIN_PASSWORD_ENCODED)\"" >> "$dest"
      # Optional: central CORS origins for local/dev use
      echo "CORS_ORIGINS=\"$(get_value CORS_ORIGINS)\"" >> "$dest"
      ;;
  esac
  
  chmod 600 "$dest" 2>/dev/null || true
}

# Check and generate JWT secrets if needed before writing .env files
ensure_jwt_secrets

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
