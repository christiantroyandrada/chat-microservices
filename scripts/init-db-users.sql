-- Per-service PostgreSQL roles with least-privilege access.
-- Executed once on fresh database init via docker-compose volume mount.
-- The admin user (POSTGRES_USER) creates these roles and grants them access
-- only to the tables each service needs.
--
-- Security rationale: if one microservice is compromised, the attacker cannot
-- read or modify tables belonging to other services (defense in depth).
--
-- NOTE: This script is idempotent — uses IF NOT EXISTS / DO $$ blocks so it
-- can safely re-run on container restarts without errors.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Create per-service roles (passwords injected via env vars by docker-entrypoint)
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- user-service role
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'user_svc') THEN
    CREATE ROLE user_svc WITH LOGIN PASSWORD 'PLACEHOLDER_USER_SVC';
  END IF;

  -- chat-service role
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'chat_svc') THEN
    CREATE ROLE chat_svc WITH LOGIN PASSWORD 'PLACEHOLDER_CHAT_SVC';
  END IF;

  -- notification-service role
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'notif_svc') THEN
    CREATE ROLE notif_svc WITH LOGIN PASSWORD 'PLACEHOLDER_NOTIF_SVC';
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Grant CONNECT on the chat_db database
-- ──────────────────────────────────────────────────────────────────────────────
GRANT CONNECT ON DATABASE chat_db TO user_svc;
GRANT CONNECT ON DATABASE chat_db TO chat_svc;
GRANT CONNECT ON DATABASE chat_db TO notif_svc;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Grant USAGE on the public schema (required to see tables)
-- ──────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO user_svc;
GRANT USAGE ON SCHEMA public TO chat_svc;
GRANT USAGE ON SCHEMA public TO notif_svc;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. Grant table-level permissions
--    TypeORM creates tables via the admin role (migrations). These grants give
--    each service DML-only access to its own tables.
-- ──────────────────────────────────────────────────────────────────────────────

-- user-service: users table + prekey bundles + migrations
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO user_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE prekey_bundles TO user_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE migrations TO user_svc;

-- chat-service: messages table + migrations
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE messages TO chat_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE migrations TO chat_svc;
-- chat-service needs read-only access to users for username lookups (RPC fallback)
GRANT SELECT ON TABLE users TO chat_svc;

-- notification-service: notifications table + migrations
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notifications TO notif_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE migrations TO notif_svc;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. Grant sequence usage (TypeORM auto-increment / UUID generation)
-- ──────────────────────────────────────────────────────────────────────────────
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO user_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chat_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO notif_svc;

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. Default privileges — apply to tables created by admin in the future
-- ──────────────────────────────────────────────────────────────────────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO user_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO notif_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO user_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chat_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO notif_svc;
