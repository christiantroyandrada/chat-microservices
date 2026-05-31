-- Least-privilege per-service table grants. Run as the DB admin AFTER migrations
-- have created the tables. Idempotent — safe to re-run on every deploy.
--
-- Each service role gets DML on ONLY its own tables. No cross-service grants are
-- needed: the services are decoupled (they call each other over HTTP, not SQL)
-- and there are NO cross-table foreign keys. Entity tables use uuid primary keys,
-- so no sequence grants are required (the only sequences belong to the
-- admin-owned typeorm_migrations_* tables, which the services never touch).
--
-- If a future migration adds a table, grant it to its owning service role here.

-- Reset any prior (e.g. broad) grants so this file is the single source of truth.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM user_svc, chat_svc, notif_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM user_svc, chat_svc, notif_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM user_svc, chat_svc, notif_svc;

-- user-service owns: users, prekeys
GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc;

-- chat-service owns: messages
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO chat_svc;

-- notification-service owns: notifications
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO notif_svc;
