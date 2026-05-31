#!/usr/bin/env bash
# init-db-users.sh — Create per-service PostgreSQL roles with least-privilege access.
# Mounted into /docker-entrypoint-initdb.d/ so PostgreSQL runs it on first init.
#
# Environment variables (set via docker-compose):
#   DB_USER_SVC_PASS   — password for user_svc role
#   DB_CHAT_SVC_PASS   — password for chat_svc role
#   DB_NOTIF_SVC_PASS  — password for notif_svc role
#
# If passwords are not set, generates random 32-char passwords and logs them.
# This script is idempotent — safe to re-run on container restarts.
set -euo pipefail

# Generate a random password if not provided
random_pass() {
  head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32
}

USER_SVC_PASS="${DB_USER_SVC_PASS:-$(random_pass)}"
CHAT_SVC_PASS="${DB_CHAT_SVC_PASS:-$(random_pass)}"
NOTIF_SVC_PASS="${DB_NOTIF_SVC_PASS:-$(random_pass)}"

echo "[init-db-users] Creating per-service PostgreSQL roles..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Create per-service roles (idempotent)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'user_svc') THEN
      CREATE ROLE user_svc WITH LOGIN PASSWORD '${USER_SVC_PASS}';
      RAISE NOTICE 'Created role: user_svc';
    ELSE
      ALTER ROLE user_svc WITH PASSWORD '${USER_SVC_PASS}';
      RAISE NOTICE 'Updated password for existing role: user_svc';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'chat_svc') THEN
      CREATE ROLE chat_svc WITH LOGIN PASSWORD '${CHAT_SVC_PASS}';
      RAISE NOTICE 'Created role: chat_svc';
    ELSE
      ALTER ROLE chat_svc WITH PASSWORD '${CHAT_SVC_PASS}';
      RAISE NOTICE 'Updated password for existing role: chat_svc';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'notif_svc') THEN
      CREATE ROLE notif_svc WITH LOGIN PASSWORD '${NOTIF_SVC_PASS}';
      RAISE NOTICE 'Created role: notif_svc';
    ELSE
      ALTER ROLE notif_svc WITH PASSWORD '${NOTIF_SVC_PASS}';
      RAISE NOTICE 'Updated password for existing role: notif_svc';
    END IF;
  END
  \$\$;

  -- Grant CONNECT on the database
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO user_svc;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO chat_svc;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO notif_svc;

  -- Grant USAGE on public schema
  GRANT USAGE ON SCHEMA public TO user_svc;
  GRANT USAGE ON SCHEMA public TO chat_svc;
  GRANT USAGE ON SCHEMA public TO notif_svc;

  -- NOTE: table-level privileges are intentionally NOT granted here. Each role
  -- receives DML on ONLY its own tables, granted per-table AFTER migrations run
  -- (the tables don't exist yet at init time). See grant-service-privileges.sql,
  -- applied by the deploy and the integration test post-migration.
EOSQL

echo "[init-db-users] ✓ Per-service PostgreSQL roles created successfully"
