#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/chat-app}"
SERVICE_DIR="$DEPLOY_PATH/chat-microservices"
COMPOSE_FILE="${BACKEND_COMPOSE_FILE:-$SERVICE_DIR/backend.compose.yml}"
STATE_FILE="${RELEASE_STATE_FILE:-$DEPLOY_PATH/release-state.env}"
PENDING_STATE_FILE="${RELEASE_PENDING_STATE_FILE:-${STATE_FILE}.pending}"
LOCK_PATH="${RELEASE_LOCK_PATH:-/opt/chat-app/.release.lock}"
PROJECT_NAME="chat-microservices"
REPO_OWNER="${REPO_OWNER:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-postgres}"
ADMIN_PASSWORD_ENCODED="${ADMIN_PASSWORD_ENCODED:-}"

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
cleanup() {
  rm -f "${STATE_FILE}.tmp.$$" "${PENDING_STATE_FILE}.tmp.$$" "$PENDING_STATE_FILE" "${COMPOSE_FILE}.tmp.$$"
  exec 9>&- || true
}
trap cleanup EXIT

JWT_SECRET_FILE="$DEPLOY_PATH/.jwt_secret"
if [[ ! -s "$JWT_SECRET_FILE" ]]; then
  umask 077
  openssl rand -base64 64 | tr -d '\n' > "$JWT_SECRET_FILE"
fi
JWT_SECRET="$(<"$JWT_SECRET_FILE")"
export JWT_SECRET

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

if [[ -n "${CURRENT_USER:-}${CURRENT_CHAT:-}${CURRENT_NOTIFICATION:-}${CURRENT_NGINX:-}" ]]; then
  [[ -n "${CURRENT_USER:-}" && -n "${CURRENT_CHAT:-}" && -n "${CURRENT_NOTIFICATION:-}" && -n "${CURRENT_NGINX:-}" ]] ||
    die "current release state is not complete or coherent"
fi
if [[ -n "${PREVIOUS_USER:-}${PREVIOUS_CHAT:-}${PREVIOUS_NOTIFICATION:-}${PREVIOUS_NGINX:-}" ]]; then
  [[ -n "${PREVIOUS_USER:-}" && -n "${PREVIOUS_CHAT:-}" && -n "${PREVIOUS_NOTIFICATION:-}" && -n "${PREVIOUS_NGINX:-}" ]] ||
    die "previous release state is not complete or coherent"
fi

TARGET_ALREADY_CURRENT=0
if [[ "${CURRENT_USER:-}" == "$USER_IMAGE_REF" && "${CURRENT_CHAT:-}" == "$CHAT_IMAGE_REF" &&
      "${CURRENT_NOTIFICATION:-}" == "$NOTIFICATION_IMAGE_REF" && "${CURRENT_NGINX:-}" == "$NGINX_IMAGE_REF" ]]; then
  TARGET_ALREADY_CURRENT=1
fi

write_state() {
  local user_current="$1" chat_current="$2" notification_current="$3" nginx_current="$4"
  local user_previous="${5:-}" chat_previous="${6:-}" notification_previous="${7:-}" nginx_previous="${8:-}"
  local tmp="${STATE_FILE}.tmp.$$"
  local source="/dev/null"
  [[ -f "$STATE_FILE" ]] && source="$STATE_FILE"

  if [[ "${RELEASE_FAIL_STATE_WRITE:-}" == "1" ]]; then
    return 1
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
        if (!( $1 in seen) && value[$1] != "") { print $1, value[$1]; seen[$1] = 1 }
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
  if [[ "${RELEASE_FAIL_AFTER_STATE_TEMP:-}" == "1" ]]; then
    return 1
  fi
  mv -f "$tmp" "$STATE_FILE"
}

write_pending_state() {
  local tmp="${PENDING_STATE_FILE}.tmp.$$"
  umask 077
  cat > "$tmp" <<EOF
user.pending=$USER_IMAGE_REF
chat.pending=$CHAT_IMAGE_REF
notification.pending=$NOTIFICATION_IMAGE_REF
nginx.pending=$NGINX_IMAGE_REF
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$PENDING_STATE_FILE"
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
      POSTGRES_PASSWORD: \${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}
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
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is required}
      MESSAGE_BROKER_URL: \${MESSAGE_BROKER_URL:?MESSAGE_BROKER_URL is required}
      CORS_ORIGINS: \${CORS_ORIGINS:?CORS_ORIGINS is required}
      DATABASE_URL: \${DATABASE_URL_USER:-postgresql://user_svc:\${DB_USER_SVC_PASS:?DB_USER_SVC_PASS is required}@postgres:5432/chat_db}
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "require('http').get('http://localhost:8081/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3
  chat:
    image: ${CHAT_IMAGE_REF}
    restart: always
    expose: ["8082"]
    environment:
      NODE_ENV: production
      PORT: "8082"
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is required}
      MESSAGE_BROKER_URL: \${MESSAGE_BROKER_URL:?MESSAGE_BROKER_URL is required}
      CORS_ORIGINS: \${CORS_ORIGINS:?CORS_ORIGINS is required}
      DATABASE_URL: \${DATABASE_URL_CHAT:-postgresql://chat_svc:\${DB_CHAT_SVC_PASS:?DB_CHAT_SVC_PASS is required}@postgres:5432/chat_db}
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "require('http').get('http://localhost:8082/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3
  notification:
    image: ${NOTIFICATION_IMAGE_REF}
    restart: always
    expose: ["8083"]
    environment:
      NODE_ENV: production
      PORT: "8083"
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is required}
      MESSAGE_BROKER_URL: \${MESSAGE_BROKER_URL:?MESSAGE_BROKER_URL is required}
      SMTP_HOST: \${SMTP_HOST:-smtp-relay.brevo.com}
      SMTP_PORT: "587"
      SMTP_USER: \${SMTP_USER:?SMTP_USER is required}
      SMTP_PASS: \${SMTP_PASS:?SMTP_PASS is required}
      SENDINBLUE_APIKEY: \${SENDINBLUE_APIKEY:?SENDINBLUE_APIKEY is required}
      EMAIL_FROM: \${EMAIL_FROM:-no-reply@ctaprojects.xyz}
      NOTIFICATIONS_QUEUE: \${NOTIFICATIONS_QUEUE:-NOTIFICATIONS}
      CORS_ORIGINS: \${CORS_ORIGINS:?CORS_ORIGINS is required}
      DATABASE_URL: \${DATABASE_URL_NOTIFICATION:-postgresql://notif_svc:\${DB_NOTIF_SVC_PASS:?DB_NOTIF_SVC_PASS is required}@postgres:5432/chat_db}
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "require('http').get('http://localhost:8083/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3
  nginx:
    image: ${NGINX_IMAGE_REF}
    restart: always
    ports: ["0.0.0.0:80:8080", "0.0.0.0:443:8443"]
    volumes:
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./certbot/www:/var/www/certbot:ro
    depends_on:
      user: { condition: service_started }
      chat: { condition: service_started }
      notification: { condition: service_started }
    healthcheck:
      test: ["CMD-SHELL", "timeout 2 bash -c '</dev/tcp/localhost/8080' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
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
  local admin_url="postgresql://${ADMIN_USERNAME}:${ADMIN_PASSWORD_ENCODED}@postgres:5432/chat_db"
  compose run --rm --no-deps -e DATABASE_URL="$admin_url" user build/src/migrate.js || return 1
  compose run --rm --no-deps -e DATABASE_URL="$admin_url" chat build/src/migrate.js || return 1
  compose run --rm --no-deps -e DATABASE_URL="$admin_url" notification build/src/migrate.js || return 1
}

grant_service_tables() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$ADMIN_USERNAME" -d chat_db \
    -c "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM user_svc, chat_svc, notif_svc;" \
    -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM user_svc, chat_svc, notif_svc;" \
    -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM user_svc, chat_svc, notif_svc;" \
    -c "GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc;" \
    -c "GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO chat_svc;" \
    -c "GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO notif_svc;" || return 1
}

ensure_dependencies() {
  mkdir -p "$SERVICE_DIR/certbot/conf" "$SERVICE_DIR/certbot/www"
  if ! docker network inspect n8n_nginx_bridge >/dev/null 2>&1; then
    docker network create n8n_nginx_bridge >/dev/null
  fi
}

provision_database() {
  [[ -n "${ADMIN_PASSWORD_ENCODED:-}" && -n "${DB_USER_SVC_PASS:-}" && -n "${DB_CHAT_SVC_PASS:-}" && -n "${DB_NOTIF_SVC_PASS:-}" ]] ||
    { echo "release-backend: database role credentials are required" >&2; return 1; }
  local password
  for password in "$DB_USER_SVC_PASS" "$DB_CHAT_SVC_PASS" "$DB_NOTIF_SVC_PASS"; do
    [[ "$password" =~ ^[A-Za-z0-9]+$ ]] || { echo "release-backend: role passwords must be alphanumeric" >&2; return 1; }
  done
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$ADMIN_USERNAME" -d chat_db \
    -c "DO \\$\$ BEGIN CREATE ROLE user_svc LOGIN PASSWORD '${DB_USER_SVC_PASS}'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE user_svc LOGIN PASSWORD '${DB_USER_SVC_PASS}'; END \\$\$;" \
    -c "DO \\$\$ BEGIN CREATE ROLE chat_svc LOGIN PASSWORD '${DB_CHAT_SVC_PASS}'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE chat_svc LOGIN PASSWORD '${DB_CHAT_SVC_PASS}'; END \\$\$;" \
    -c "DO \\$\$ BEGIN CREATE ROLE notif_svc LOGIN PASSWORD '${DB_NOTIF_SVC_PASS}'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE notif_svc LOGIN PASSWORD '${DB_NOTIF_SVC_PASS}'; END \\$\$;" \
    -c "GRANT CONNECT ON DATABASE chat_db TO user_svc, chat_svc, notif_svc;" \
    -c "GRANT USAGE ON SCHEMA public TO user_svc, chat_svc, notif_svc;" || return 1
}

wait_for_postgres() {
  local timeout="${RELEASE_DB_READY_TIMEOUT:-120}" interval="${RELEASE_POLL_INTERVAL:-5}"
  local max_attempts="${RELEASE_DB_READY_MAX_ATTEMPTS:-60}" attempts=0 deadline=$((SECONDS + timeout))
  while (( attempts < max_attempts )); do
    if compose exec -T postgres pg_isready -U "$ADMIN_USERNAME" -d chat_db >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    if (( SECONDS >= deadline || attempts >= max_attempts )); then
      echo "release-backend: postgres did not become ready" >&2
      return 1
    fi
    (( interval > 0 )) && sleep "$interval"
  done
}

health_check() {
  local service route timeout interval max_attempts attempts deadline status
  timeout="${RELEASE_HEALTH_TIMEOUT:-120}"
  interval="${RELEASE_POLL_INTERVAL:-5}"
  max_attempts="${RELEASE_HEALTH_MAX_ATTEMPTS:-60}"
  for service in user chat notification nginx; do
    case "$service" in
      user) route=/api/user/health ;;
      chat) route=/chat/health ;;
      notification) route=/notifications/health ;;
      nginx) route=/health ;;
    esac
    attempts=0
    deadline=$((SECONDS + timeout))
    while (( attempts < max_attempts )); do
      if [[ -n "${RELEASE_HEALTHCHECK_COMMAND:-}" ]]; then
        if RELEASE_HEALTH_SERVICE="$service" RELEASE_HEALTH_PATH="$route" bash -c "$RELEASE_HEALTHCHECK_COMMAND"; then
          break
        fi
      else
        status="$(compose ps "$service" --format '{{.Health}}' | tr -d '\r')"
        if [[ "$status" == "healthy" ]]; then
          break
        fi
      fi
      attempts=$((attempts + 1))
      if (( SECONDS >= deadline || attempts >= max_attempts )); then
        echo "release-backend: health check failed for $service" >&2
        return 1
      fi
      (( interval > 0 )) && sleep "$interval"
    done
  done

  if [[ -z "${RELEASE_HEALTHCHECK_COMMAND:-}" ]]; then
    local health_url="${RELEASE_HEALTH_URL:-https://localhost}"
    for route in /api/user/health /chat/health /notifications/health; do
      curl --fail --silent --show-error --max-time "$timeout" -k -H 'Host: chat.ctaprojects.xyz' "${health_url%/}$route" >/dev/null || {
        echo "release-backend: public health check failed for $route" >&2
        return 1
      }
    done
  fi
}

verify_running_images() {
  local service container image expected
  for service in user chat notification nginx; do
    case "$service" in
      user) expected="$USER_IMAGE_REF" ;;
      chat) expected="$CHAT_IMAGE_REF" ;;
      notification) expected="$NOTIFICATION_IMAGE_REF" ;;
      nginx) expected="$NGINX_IMAGE_REF" ;;
    esac
    container="$(compose ps -q "$service" | head -n 1)"
    [[ -n "$container" ]] || {
      echo "release-backend: running container missing for $service" >&2
      return 1
    }
    image="$(RELEASE_EXPECTED_IMAGE="$expected" docker inspect --format '{{.Config.Image}}' "$container")"
    [[ "$image" == "$expected" ]] || {
      echo "release-backend: running image mismatch for $service (expected $expected, got $image)" >&2
      return 1
    }
  done
}

pull_images() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io --username "$REPO_OWNER" --password-stdin || return 1
  fi
  docker pull "$USER_IMAGE_REF" || return 1
  docker pull "$CHAT_IMAGE_REF" || return 1
  docker pull "$NOTIFICATION_IMAGE_REF" || return 1
  docker pull "$NGINX_IMAGE_REF" || return 1
}

run_broker_preflight() {
  [[ -n "${MESSAGE_BROKER_URL:-}" ]] || {
    echo "release-backend: MESSAGE_BROKER_URL is required for broker preflight" >&2
    return 1
  }
  docker run --rm --env MESSAGE_BROKER_URL "$CHAT_IMAGE_REF" build/src/preflight/brokerPreflight.js
}

deploy_candidate() {
  [[ "${MIGRATIONS_ROLLBACK_SAFE:-}" == "true" ]] || {
    echo "release-backend: MIGRATIONS_ROLLBACK_SAFE=true is required" >&2
    return 1
  }
  write_pending_state || return 1
  [[ "${RELEASE_FAIL_AFTER_PENDING:-}" != "1" ]] || return 1
  write_compose || return 1
  ensure_dependencies || return 1
  compose up -d postgres || return 1
  wait_for_postgres || return 1
  provision_database || return 1
  run_migrations || return 1
  grant_service_tables || return 1
  compose up -d --no-deps user chat notification nginx || return 1
  verify_running_images || return 1
  health_check || return 1
  if (( TARGET_ALREADY_CURRENT == 0 )); then
    write_state "$USER_IMAGE_REF" "$CHAT_IMAGE_REF" "$NOTIFICATION_IMAGE_REF" "$NGINX_IMAGE_REF" \
      "${CURRENT_USER:-}" "${CURRENT_CHAT:-}" "${CURRENT_NOTIFICATION:-}" "${CURRENT_NGINX:-}"
  fi
}

rollback() {
  local rollback_user rollback_chat rollback_notification rollback_nginx
  rollback_user="${CURRENT_USER:-}"
  rollback_chat="${CURRENT_CHAT:-}"
  rollback_notification="${CURRENT_NOTIFICATION:-}"
  rollback_nginx="${CURRENT_NGINX:-}"
  [[ -n "$rollback_user" && -n "$rollback_chat" &&
     -n "$rollback_notification" && -n "$rollback_nginx" ]] || {
    echo "release-backend: no complete rollback generation; refusing invented rollback" >&2
    return 1
  }
  USER_IMAGE_REF="$rollback_user"
  CHAT_IMAGE_REF="$rollback_chat"
  NOTIFICATION_IMAGE_REF="$rollback_notification"
  NGINX_IMAGE_REF="$rollback_nginx"
  write_compose
  compose pull user chat notification nginx || return 1
  compose up -d --no-deps user chat notification nginx || return 1
  verify_running_images || return 1
  if [[ -n "${RELEASE_ROLLBACK_HEALTHCHECK_COMMAND:-}" ]]; then
    bash -c "$RELEASE_ROLLBACK_HEALTHCHECK_COMMAND" || return 1
  else
    health_check || return 1
  fi
}

if ! pull_images; then
  echo "release-backend: immutable image pull failed" >&2
  exit 1
fi
if ! run_broker_preflight; then
  echo "release-backend: broker preflight failed" >&2
  exit 1
fi

if deploy_candidate; then
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
