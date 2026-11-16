-- Least-privilege per-service table grants. Run as the DB admin AFTER migrations
-- have created the tables. Idempotent — safe to re-run on every deploy.
--
-- Each service role gets DML on ONLY its own tables. No cross-service grants are
-- needed because the services do not query each other's tables.
-- There are no cross-service foreign keys. Entity tables use UUID primary keys,
-- so no sequence grants are required (the only sequences belong to the
-- admin-owned typeorm_migrations_* tables, which the services never touch).
--
-- If a future migration adds a table, grant it to its owning service role here.

-- Reset prior grants. Keep this list in sync with deploy/release-backend.sh.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM user_svc, chat_svc, notif_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM user_svc, chat_svc, notif_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM user_svc, chat_svc, notif_svc;

-- user-service owns: users, prekeys
GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc;

-- chat-service owns: messages, outbox_events
GRANT SELECT, INSERT, UPDATE, DELETE ON messages, outbox_events TO chat_svc;

-- notification-service owns: notification_inbox, notifications
GRANT SELECT, INSERT, UPDATE ON notification_inbox TO notif_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO notif_svc;
