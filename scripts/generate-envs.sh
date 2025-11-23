#!/usr/bin/env bash
# Generate per-service .env files from consolidated docker-secrets/app_secrets
# Usage: from repo root, run: ./scripts/generate-envs.sh [--force]
#   --force: Overwrite existing .env files

set -euo pipefail

# Parse args: support --force and --secrets-file=PATH (or --secrets-file PATH)
FORCE=false
SECRETS_OVERRIDE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --secrets-file=*)
      SECRETS_OVERRIDE="${1#*=}"
      shift
      ;;
    --secrets-file)
      shift
      SECRETS_OVERRIDE="${1:-}"
      shift || true
      ;;
    *)
      # ignore unknown args
      shift
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Default canonical secrets path inside the repo (where docker-compose expects it)
DEFAULT_SECRETS_PATH="$ROOT_DIR/docker-secrets/app_secrets"

# Allow an override from the CLI or environment
if [ -n "${SECRETS_OVERRIDE:-}" ]; then
  SECRETS_FILE="$SECRETS_OVERRIDE"
elif [ -n "${SECRETS_FILE:-}" ]; then
  # preserve externally provided SECRETS_FILE env if present
  SECRETS_FILE="$SECRETS_FILE"
else
  SECRETS_FILE="$DEFAULT_SECRETS_PATH"
fi

# Hold a generated JWT secret at runtime so we don't need to persist it into
# the checked-in `docker-secrets/app_secrets` file. This keeps secrets out of
# repo while still allowing `setup` to populate per-service .env files.
GENERATED_JWT_SECRET=""

if [ ! -f "$SECRETS_FILE" ]; then
  # Try to locate a candidate secrets file elsewhere in the repo or parent dirs
  echo "Secrets file not found at: $SECRETS_FILE"
  echo "Searching for an existing 'app_secrets' or example file..."

  # Search common locations: repo docker-secrets, parent repo, any app_secrets* within a small depth
  FOUND=""
  CANDIDATES=(
    "$ROOT_DIR/docker-secrets/app_secrets"
    "$ROOT_DIR/docker-secrets/app_secrets.example"
    "$ROOT_DIR/../docker-secrets/app_secrets"
    "$ROOT_DIR/../docker-secrets/app_secrets.example"
    "$ROOT_DIR/app_secrets"
    "$ROOT_DIR/app_secrets.example"
  )
  for c in "${CANDIDATES[@]}"; do
    if [ -f "$c" ]; then
      FOUND="$c"
      break
    fi
  done

  if [ -z "$FOUND" ]; then
    # Fallback: shallow find inside repository (maxdepth 3) for files starting with app_secrets
    FOUND=$(find "$ROOT_DIR" -maxdepth 3 -type f -iname 'app_secrets*' -print -quit 2>/dev/null || true)
  fi

  if [ -n "$FOUND" ] && [ -f "$FOUND" ]; then
    echo "Found secrets candidate: $FOUND"
    # Ensure docker-secrets dir exists in the repo
    mkdir -p "$ROOT_DIR/docker-secrets"
    # If the canonical repo path doesn't exist, create a symlink there that points to the discovered file.
    if [ ! -e "$DEFAULT_SECRETS_PATH" ]; then
      ln -s "$FOUND" "$DEFAULT_SECRETS_PATH"
      echo "Created symlink: $DEFAULT_SECRETS_PATH -> $FOUND"
    else
      echo "A file already exists at $DEFAULT_SECRETS_PATH; leaving it in place."
    fi
    SECRETS_FILE="$DEFAULT_SECRETS_PATH"
  else
    echo "No existing secrets file or example found."
    echo "Please copy docker-secrets/app_secrets.example to docker-secrets/app_secrets and populate it first."
    exit 1
  fi
fi

get_value() {
  local key="$1"
  # If we generated a JWT secret at runtime, return it when asked for JWT_SECRET
  if [ "$key" = "JWT_SECRET" ] && [ -n "$GENERATED_JWT_SECRET" ]; then
    printf "%s" "$GENERATED_JWT_SECRET"
    return
  fi

  # Allow environment variables to override secrets file values
  if [ -n "${!key:-}" ]; then
    printf "%s" "${!key}"
    return
  fi

  # Use a safe grep invocation that doesn't fail under 'set -euo pipefail'
  # Trim surrounding single/double quotes and surrounding whitespace
  (grep -m1 "^${key}=" "$SECRETS_FILE" 2>/dev/null || true) \
    | head -1 \
    | cut -d'=' -f2- \
    | perl -pe 's/^["\x27]//; s/["\x27]$//; s/^[[:space:]]+//; s/[[:space:]]+$//'
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
    # Do NOT persist the generated secret back into the checked-in
    # docker-secrets file. Instead, store it in memory for use when
    # writing per-service .env files. This avoids hardcoding secrets
    # into repository files while keeping the setup flow functional.
    GENERATED_JWT_SECRET="$new_secret"
    needs_update=true
  fi
  
  if [ "$needs_update" = true ]; then
    echo "✓ Generated strong shared JWT secret (not persisted to app_secrets)"
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
