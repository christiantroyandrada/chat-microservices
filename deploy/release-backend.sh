#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/chat-app}"
SERVICE_DIR="$DEPLOY_PATH/chat-microservices"
COMPOSE_FILE="${BACKEND_COMPOSE_FILE:-$SERVICE_DIR/backend.compose.yml}"
STATE_FILE="${RELEASE_STATE_FILE:-$DEPLOY_PATH/release-state.env}"
LOCK_PATH="${RELEASE_LOCK_PATH:-/opt/chat-app/.release.lock}"
PROJECT_NAME="chat-microservices"
REPO_OWNER="${REPO_OWNER:-}"
IMAGE_TAG="${IMAGE_TAG:-}"

die() {
  echo "release-backend: $*" >&2
  exit 1
}

[[ -n "$REPO_OWNER" ]] || die "REPO_OWNER is required"
[[ "$REPO_OWNER" =~ ^[a-z0-9-]+$ ]] || die "REPO_OWNER is not a valid GHCR owner"

USER_IMAGE_REF="${USER_IMAGE:-ghcr.io/$REPO_OWNER/chat-user-service:$IMAGE_TAG}"
CHAT_IMAGE_REF="${CHAT_IMAGE:-ghcr.io/$REPO_OWNER/chat-chat-service:$IMAGE_TAG}"
NOTIFICATION_IMAGE_REF="${NOTIFICATION_IMAGE:-ghcr.io/$REPO_OWNER/chat-notification-service:$IMAGE_TAG}"
NGINX_IMAGE_REF="${NGINX_IMAGE:-ghcr.io/$REPO_OWNER/chat-nginx:$IMAGE_TAG}"

validate_ref() {
  local service="$1" ref="$2" repository
  case "$service" in
    user) repository=chat-user-service ;;
    chat) repository=chat-chat-service ;;
    notification) repository=chat-notification-service ;;
    nginx) repository=chat-nginx ;;
    *) die "unknown owned service: $service" ;;
  esac
  [[ "$ref" =~ ^ghcr\.io/$REPO_OWNER/$repository:[0-9a-fA-F]{40}$ ]] || \
    die "immutable image ref rejected for $service"
}

validate_ref user "$USER_IMAGE_REF"
validate_ref chat "$CHAT_IMAGE_REF"
validate_ref notification "$NOTIFICATION_IMAGE_REF"
validate_ref nginx "$NGINX_IMAGE_REF"

mkdir -p "$DEPLOY_PATH" "$SERVICE_DIR"
command -v flock >/dev/null 2>&1 || die "flock is required"
exec 9>"$LOCK_PATH"
flock -x 9
trap 'exec 9>&-' EXIT

while IFS='=' read -r key value; do
  case "$key" in
    user.current) CURRENT_USER="$value" ;;
    user.previous) PREVIOUS_USER="$value" ;;
    chat.current) CURRENT_CHAT="$value" ;;
    chat.previous) PREVIOUS_CHAT="$value" ;;
    notification.current) CURRENT_NOTIFICATION="$value" ;;
    notification.previous) PREVIOUS_NOTIFICATION="$value" ;;
    nginx.current) CURRENT_NGINX="$value" ;;
    nginx.previous) PREVIOUS_NGINX="$value" ;;
  esac
done < <([[ -f "$STATE_FILE" ]] && awk 'NF || /^$/' "$STATE_FILE" || true)

[[ -z "${CURRENT_USER:-}" ]] || validate_ref user "$CURRENT_USER"
[[ -z "${CURRENT_CHAT:-}" ]] || validate_ref chat "$CURRENT_CHAT"
[[ -z "${CURRENT_NOTIFICATION:-}" ]] || validate_ref notification "$CURRENT_NOTIFICATION"
[[ -z "${CURRENT_NGINX:-}" ]] || validate_ref nginx "$CURRENT_NGINX"
[[ -z "${PREVIOUS_USER:-}" ]] || validate_ref user "$PREVIOUS_USER"
[[ -z "${PREVIOUS_CHAT:-}" ]] || validate_ref chat "$PREVIOUS_CHAT"
[[ -z "${PREVIOUS_NOTIFICATION:-}" ]] || validate_ref notification "$PREVIOUS_NOTIFICATION"
[[ -z "${PREVIOUS_NGINX:-}" ]] || validate_ref nginx "$PREVIOUS_NGINX"

write_state() {
  local user_current="$1" chat_current="$2" notification_current="$3" nginx_current="$4"
  local user_previous="${5:-}" chat_previous="${6:-}" notification_previous="${7:-}" nginx_previous="${8:-}"
  local tmp="${STATE_FILE}.tmp.$$"
  local source="/dev/null"
  [[ -f "$STATE_FILE" ]] && source="$STATE_FILE"

  if [[ "${RELEASE_FAIL_STATE_WRITE:-}" == "1" ]]; then
    die "injected state-write failure"
  fi

  umask 077
  awk -F= -v OFS='=' \
    -v uc="$user_current" -v up="$user_previous" \
    -v cc="$chat_current" -v cp="$chat_previous" \
    -v nc="$notification_current" -v np="$notification_previous" \
    -v xc="$nginx_current" -v xp="$nginx_previous" '
    BEGIN {
      value["user.current"] = uc; value["user.previous"] = up
      value["chat.current"] = cc; value["chat.previous"] = cp
      value["notification.current"] = nc; value["notification.previous"] = np
      value["nginx.current"] = xc; value["nginx.previous"] = xp
      order[1] = "user.current"; order[2] = "user.previous"
      order[3] = "chat.current"; order[4] = "chat.previous"
      order[5] = "notification.current"; order[6] = "notification.previous"
      order[7] = "nginx.current"; order[8] = "nginx.previous"
    }
    /^[[:alnum:]_-]+\.(current|previous)=/ {
      if ($1 in value) {
        if (value[$1] != "") { print $1, value[$1]; seen[$1] = 1 }
        next
      }
    }
    { print }
    END {
      for (i = 1; i <= 8; i++) {
        key = order[i]
        if (!(key in seen) && value[key] != "") print key, value[key]
      }
    }
  ' "$source" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

write_compose() {
  local tmp="${COMPOSE_FILE}.tmp.$$"
  cat > "$tmp" <<EOF
name: $PROJECT_NAME
services:
  postgres:
    image: postgres:17-bookworm
    restart: unless-stopped
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: ${ADMIN_USERNAME:-postgres}
      POSTGRES_PASSWORD: ${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}
      POSTGRES_DB: chat_db
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \\"\$\$POSTGRES_USER\\" -d chat_db"]
      interval: 10s
      timeout: 5s
      retries: 5
  user:
    image: ${USER_IMAGE_REF}
    restart: always
    expose: ["8081"]
    environment:
      NODE_ENV: production
      PORT: "8081"
      DATABASE_URL: ${DATABASE_URL_USER:?DATABASE_URL_USER is required}
    depends_on:
      postgres: { condition: service_healthy }
  chat:
    image: ${CHAT_IMAGE_REF}
    restart: always
    expose: ["8082"]
    environment:
      NODE_ENV: production
      PORT: "8082"
      DATABASE_URL: ${DATABASE_URL_CHAT:?DATABASE_URL_CHAT is required}
    depends_on:
      postgres: { condition: service_healthy }
  notification:
    image: ${NOTIFICATION_IMAGE_REF}
    restart: always
    expose: ["8083"]
    environment:
      NODE_ENV: production
      PORT: "8083"
      DATABASE_URL: ${DATABASE_URL_NOTIFICATION:?DATABASE_URL_NOTIFICATION is required}
    depends_on:
      postgres: { condition: service_healthy }
  nginx:
    image: ${NGINX_IMAGE_REF}
    restart: always
    ports: ["0.0.0.0:80:8080", "0.0.0.0:443:8443"]
    depends_on:
      user: { condition: service_started }
      chat: { condition: service_started }
      notification: { condition: service_started }
    networks: [default, n8n_nginx_bridge]
volumes:
  postgres-data:
networks:
  n8n_nginx_bridge:
    external: true
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$COMPOSE_FILE"
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

run_migrations() {
  compose run --rm --no-deps user build/src/migrate.js || return 1
  compose run --rm --no-deps chat build/src/migrate.js || return 1
  compose run --rm --no-deps notification build/src/migrate.js || return 1
}

health_check() {
  if [[ -n "${RELEASE_HEALTHCHECK_COMMAND:-}" ]]; then
    bash -c "$RELEASE_HEALTHCHECK_COMMAND"
  else
    curl --fail --silent --show-error --max-time "${RELEASE_HEALTH_TIMEOUT:-30}" \
      "${RELEASE_HEALTH_URL:-http://localhost:80/health}" >/dev/null
  fi
}

deploy_images() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io --username "$REPO_OWNER" --password-stdin || return 1
  fi
  compose pull user chat notification nginx || return 1
  compose up -d postgres || return 1
  run_migrations || return 1
  compose up -d --no-deps user chat notification nginx || return 1
  health_check || return 1
}

rollback() {
  [[ -n "${CURRENT_USER:-}" && -n "${PREVIOUS_USER:-}" && -n "${CURRENT_CHAT:-}" && -n "${PREVIOUS_CHAT:-}" &&
     -n "${CURRENT_NOTIFICATION:-}" && -n "${PREVIOUS_NOTIFICATION:-}" && -n "${CURRENT_NGINX:-}" && -n "${PREVIOUS_NGINX:-}" ]] || {
    echo "release-backend: no complete previous release; refusing invented rollback" >&2
    return 1
  }
  USER_IMAGE_REF="$PREVIOUS_USER"
  CHAT_IMAGE_REF="$PREVIOUS_CHAT"
  NOTIFICATION_IMAGE_REF="$PREVIOUS_NOTIFICATION"
  NGINX_IMAGE_REF="$PREVIOUS_NGINX"
  write_compose
  compose pull user chat notification nginx || return 1
  compose up -d --no-deps user chat notification nginx || return 1
  if [[ -n "${RELEASE_ROLLBACK_HEALTHCHECK_COMMAND:-}" ]]; then
    bash -c "$RELEASE_ROLLBACK_HEALTHCHECK_COMMAND" || return 1
  else
    health_check || return 1
  fi
  write_state "$PREVIOUS_USER" "$PREVIOUS_CHAT" "$PREVIOUS_NOTIFICATION" "$PREVIOUS_NGINX" \
    "${IMAGE_USER_FAILED}" "${IMAGE_CHAT_FAILED}" "${IMAGE_NOTIFICATION_FAILED}" "${IMAGE_NGINX_FAILED}"
}

IMAGE_USER_FAILED="$USER_IMAGE_REF"
IMAGE_CHAT_FAILED="$CHAT_IMAGE_REF"
IMAGE_NOTIFICATION_FAILED="$NOTIFICATION_IMAGE_REF"
IMAGE_NGINX_FAILED="$NGINX_IMAGE_REF"

write_compose
write_state "$USER_IMAGE_REF" "$CHAT_IMAGE_REF" "$NOTIFICATION_IMAGE_REF" "$NGINX_IMAGE_REF" \
  "${CURRENT_USER:-}" "${CURRENT_CHAT:-}" "${CURRENT_NOTIFICATION:-}" "${CURRENT_NGINX:-}"

if deploy_images; then
  echo "release-backend: deployed immutable backend release"
else
  echo "release-backend: health or deployment failed; attempting exact rollback" >&2
  if rollback; then
    echo "release-backend: rollback completed" >&2
  else
    echo "release-backend: rollback failed or unavailable; manual intervention required" >&2
  fi
  exit 1
fi
