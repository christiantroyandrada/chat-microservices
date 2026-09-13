import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const script = path.join(repo, 'deploy/release-backend.sh');
const verifier = path.join(repo, 'scripts/verify-deployment-workflow.mjs');
const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const olderSha = 'c'.repeat(40);

async function harness({ state = '', dockerBody = '', extraEnv = {}, realFlock = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backend-release-'));
  const bin = path.join(root, 'bin');
  await (await import('node:fs/promises')).mkdir(bin);
  const log = path.join(root, 'docker.log');
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\n' "docker $*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = compose ] && echo "$*" | grep -q 'ps .*--format'; then
  printf '%s\n' "\${FAKE_HEALTH_STATUS:-healthy}"
  exit 0
fi
if [ "$1" = compose ] && echo "$*" | grep -q 'ps -q'; then
  case "$*" in
    *'ps -q user'*) printf '%s\n' user-container ;;
    *'ps -q chat'*) printf '%s\n' chat-container ;;
    *'ps -q notification'*) printf '%s\n' notification-container ;;
    *'ps -q nginx'*) printf '%s\n' nginx-container ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$*" in
    *user-container*) printf '%s\n' "\${RUNTIME_USER_IMAGE:-\$RELEASE_EXPECTED_IMAGE}" ;;
    *chat-container*) printf '%s\n' "\${RUNTIME_CHAT_IMAGE:-\$RELEASE_EXPECTED_IMAGE}" ;;
    *notification-container*) printf '%s\n' "\${RUNTIME_NOTIFICATION_IMAGE:-\$RELEASE_EXPECTED_IMAGE}" ;;
    *nginx-container*) printf '%s\n' "\${RUNTIME_NGINX_IMAGE:-\$RELEASE_EXPECTED_IMAGE}" ;;
  esac
  exit 0
fi
${dockerBody}
exit 0
`);
  await writeFile(path.join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_CURL_LOG"\nexit 0\n');
  await writeFile(path.join(bin, 'mv'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_MV_LOG"\nexec /bin/mv "$@"\n');
  if (!realFlock) await writeFile(path.join(bin, 'flock'), '#!/bin/sh\nprintf "%s\\n" "flock $*" >> "$FAKE_FLOCK_LOG"\nexit 0\n');
  await chmod(path.join(bin, 'docker'), 0o755);
  await chmod(path.join(bin, 'curl'), 0o755);
  await chmod(path.join(bin, 'mv'), 0o755);
  if (!realFlock) await chmod(path.join(bin, 'flock'), 0o755);
  await writeFile(path.join(root, 'release-state.env'), state);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DEPLOY_PATH: root,
    RELEASE_LOCK_PATH: path.join(root, '.release.lock'),
    REPO_OWNER: 'acme',
    IMAGE_TAG: sha,
    USER_IMAGE: `ghcr.io/acme/chat-user-service:${sha}`,
    CHAT_IMAGE: `ghcr.io/acme/chat-chat-service:${sha}`,
    NOTIFICATION_IMAGE: `ghcr.io/acme/chat-notification-service:${sha}`,
    NGINX_IMAGE: `ghcr.io/acme/chat-nginx:${sha}`,
    ADMIN_PASSWORD: 'test-only-secret',
    ADMIN_USERNAME: 'postgres',
    ADMIN_PASSWORD_ENCODED: 'test-only-secret',
    DB_USER_SVC_PASS: 'userpass',
    DB_CHAT_SVC_PASS: 'chatpass',
    DB_NOTIF_SVC_PASS: 'notifpass',
    DATABASE_URL_USER: 'postgresql://user_svc:test@postgres:5432/chat_db',
    DATABASE_URL_CHAT: 'postgresql://chat_svc:test@postgres:5432/chat_db',
    DATABASE_URL_NOTIFICATION: 'postgresql://notif_svc:test@postgres:5432/chat_db',
    MESSAGE_BROKER_URL: 'amqps://broker.example/vhost',
    MIGRATIONS_ROLLBACK_SAFE: 'true',
    RELEASE_HEALTHCHECK_COMMAND: 'true',
    RELEASE_POLL_INTERVAL: '0',
    FAKE_DOCKER_LOG: log,
    FAKE_CURL_LOG: path.join(root, 'curl.log'),
    FAKE_FLOCK_LOG: path.join(root, 'flock.log'),
    FAKE_MV_LOG: path.join(root, 'mv.log'),
    ...extraEnv,
  };
  return { root, log, env };
}

function run(env) {
  return spawnSync('bash', [script], { cwd: repo, env, encoding: 'utf8' });
}

function stateFor(ref = oldSha) {
  return [
    `user.current=ghcr.io/acme/chat-user-service:${ref}`,
    `user.previous=ghcr.io/acme/chat-user-service:${olderSha}`,
    `chat.current=ghcr.io/acme/chat-chat-service:${ref}`,
    `chat.previous=ghcr.io/acme/chat-chat-service:${olderSha}`,
    `notification.current=ghcr.io/acme/chat-notification-service:${ref}`,
    `notification.previous=ghcr.io/acme/chat-notification-service:${olderSha}`,
    `nginx.current=ghcr.io/acme/chat-nginx:${ref}`,
    `nginx.previous=ghcr.io/acme/chat-nginx:${olderSha}`,
    'custom.owner=preserved',
    '',
  ].join('\n');
}

test('static verifier accepts the immutable, split ownership workflow', () => {
  const result = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('production release rejects mutable image refs before Docker mutation', async () => {
  const h = await harness({ extraEnv: { USER_IMAGE: 'ghcr.io/acme/chat-user-service:latest' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('successful release preserves unowned state and never operates an unowned service', async () => {
  const h = await harness({ state: stateFor() });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, /^custom\.owner=preserved$/m);
  assert.match(next, new RegExp(`^user\.current=ghcr\\.io/acme/chat-user-service:${sha}$`, 'm'));
  assert.match(next, new RegExp(`^user\.previous=ghcr\\.io/acme/chat-user-service:${oldSha}$`, 'm'));
  assert.doesNotMatch(await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8'), /(^|\n)\s*frontend:/);
  assert.doesNotMatch(await readFile(h.log, 'utf8'), /compose .*frontend/);
  assert.match(await readFile(path.join(h.root, 'flock.log'), 'utf8'), /flock -x 9/);
  const names = await readdir(path.join(h.root, 'chat-microservices'));
  assert.equal(names.filter(name => name.includes('.tmp.')).length, 0);
});

test('candidate broker preflight follows immutable pulls and fails before state, migrations, or runtime mutation', async () => {
  const initial = stateFor();
  const h = await harness({
    state: initial,
    dockerBody: 'if [ "$1" = run ]; then exit 91; fi',
  });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  const log = await readFile(h.log, 'utf8');
  const preflight = log.indexOf('run --rm --env MESSAGE_BROKER_URL');
  assert.ok(preflight >= 0, 'preflight must be attempted');
  for (const image of [
    `pull ghcr.io/acme/chat-user-service:${sha}`,
    `pull ghcr.io/acme/chat-chat-service:${sha}`,
    `pull ghcr.io/acme/chat-notification-service:${sha}`,
    `pull ghcr.io/acme/chat-nginx:${sha}`,
  ]) {
    const idx = log.indexOf(image);
    assert.ok(idx >= 0, `${image} must be pulled`);
    assert.ok(preflight > idx, `${image} must precede preflight`);
  }
  assert.doesNotMatch(log, /compose .* (run|up -d)/);
  // pending state must not be created before preflight success
  const pendingExists = await readFile(path.join(h.root, 'release-state.env.pending'), 'utf8').then(() => true).catch(() => false);
  assert.equal(pendingExists, false, 'pending state must not be created on preflight failure');
});

test('failed pull or preflight does not create persistent JWT secret and leaves state/runtime untouched', async () => {
  const initial = stateFor();
  for (const dockerBody of ['if [ "$1" = pull ]; then exit 91; fi', 'if [ "$1" = run ]; then exit 91; fi']) {
    const failH = await harness({ state: initial, dockerBody });
    const sPath = path.join(failH.root, '.jwt_secret');
    const secretBefore = await readFile(sPath, 'utf8').then(() => true).catch(() => false);
    assert.equal(secretBefore, false, 'secret must be absent before test');
    const result = run(failH.env);
    assert.notEqual(result.status, 0);
    const secretAfter = await readFile(sPath, 'utf8').then(() => true).catch(() => false);
    assert.equal(secretAfter, false, 'secret file must remain absent after pull/preflight failure');
    assert.equal(await readFile(path.join(failH.root, 'release-state.env'), 'utf8'), initial);
    const log = await readFile(failH.log, 'utf8').catch(() => '');
    assert.doesNotMatch(log, /compose .* (run|up -d)/);
  }
});

test('pre-mutation migration flag rejection creates no secret, mutates nothing, and never enters rollback', async () => {
  const initial = stateFor();
  for (const flag of ['', 'false']) {
    const h = await harness({ state: initial, extraEnv: { MIGRATIONS_ROLLBACK_SAFE: flag } });
    const result = run(h.env);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /MIGRATIONS_ROLLBACK_SAFE=true is required/);
    assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
    assert.equal(await readFile(path.join(h.root, '.jwt_secret'), 'utf8').then(() => true).catch(() => false), false, 'secret must not be created on pre-mutation rejection');
    assert.equal(await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8').then(() => true).catch(() => false), false, 'compose must not be written on pre-mutation rejection');
    const log = await readFile(h.log, 'utf8').catch(() => '');
    assert.doesNotMatch(log, /compose .* (run|up -d|pull)/, log);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /attempting exact rollback|manual intervention/);
  }
});

test('pending candidate failures preserve verified state and are not treated as current on the next release', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_FAIL_AFTER_PENDING: '1' } });
  assert.notEqual(run(h.env).status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  const mvLog = await readFile(path.join(h.root, 'mv.log'), 'utf8');
  assert.match(mvLog, /release-state\.env\.pending/, 'write_pending_state must publish the pending file before failing');

  assert.equal(run({ ...h.env, RELEASE_FAIL_AFTER_PENDING: '' }).status, 0);
  const promoted = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(promoted, new RegExp(`^user\\.current=ghcr\\.io/acme/chat-user-service:${sha}$`, 'm'));
  assert.match(promoted, new RegExp(`^user\\.previous=ghcr\\.io/acme/chat-user-service:${oldSha}$`, 'm'));
});

test('health failure keeps last-known-good state authoritative and rolls runtime back once', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: 'false', RELEASE_ROLLBACK_HEALTHCHECK_COMMAND: 'true' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-user-service:${oldSha}`));
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\.current=ghcr\\.io/acme/chat-user-service:${oldSha}$`, 'm'));
  assert.equal(next, initial);
  assert.equal(((await readFile(h.log, 'utf8')).match(/ up -d --no-deps user chat notification nginx/g) || []).length, 2);
});

test('health failure with current-only state rolls back to the running release', async () => {
  const state = [
    `user.current=ghcr.io/acme/chat-user-service:${oldSha}`,
    `chat.current=ghcr.io/acme/chat-chat-service:${oldSha}`,
    `notification.current=ghcr.io/acme/chat-notification-service:${oldSha}`,
    `nginx.current=ghcr.io/acme/chat-nginx:${oldSha}`,
    '',
  ].join('\n');
  const initial = state;
  const h = await harness({ state: initial, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: 'false', RELEASE_ROLLBACK_HEALTHCHECK_COMMAND: 'true' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-user-service:${oldSha}`));
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\.current=ghcr\\.io/acme/chat-user-service:${oldSha}$`, 'm'));
  assert.equal(next, initial);
});

test('health failure with empty state fails closed without inventing rollback', async () => {
  const h = await harness({ extraEnv: { RELEASE_HEALTHCHECK_COMMAND: 'false' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /current|rollback/i);
});

test('atomic promotion failure leaves state bytes untouched and rolls runtime back once', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_FAIL_AFTER_STATE_TEMP: '1' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  const log = await readFile(h.log, 'utf8');
  assert.equal((log.match(/ up -d --no-deps user chat notification nginx/g) || []).length, 2);
  const names = await readdir(h.root);
  assert.equal(names.filter(name => name.includes('.tmp.')).length, 0);
});

test('same immutable generation converges runtime and preserves previous refs', async () => {
  const h = await harness({ state: stateFor(sha) });
  const first = run(h.env);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  await writeFile(h.log, '');
  const second = run(h.env);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const log = await readFile(h.log, 'utf8');
  assert.match(log, /compose .* up -d --no-deps user chat notification nginx/);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\\.current=ghcr\\.io/acme/chat-user-service:${sha}$`, 'm'));
  assert.match(next, new RegExp(`^user\\.previous=ghcr\\.io/acme/chat-user-service:${olderSha}$`, 'm'));
});

test('a verified current generation remains the rollback target during runtime reconciliation', async () => {
  const h = await harness({
    state: stateFor(sha),
    extraEnv: {
      RELEASE_HEALTHCHECK_COMMAND: 'true',
      RELEASE_ROLLBACK_HEALTHCHECK_COMMAND: 'true',
      RUNTIME_USER_IMAGE: `ghcr.io/acme/chat-user-service:${olderSha}`,
      RUNTIME_CHAT_IMAGE: `ghcr.io/acme/chat-chat-service:${olderSha}`,
      RUNTIME_NOTIFICATION_IMAGE: `ghcr.io/acme/chat-notification-service:${olderSha}`,
      RUNTIME_NGINX_IMAGE: `ghcr.io/acme/chat-nginx:${olderSha}`,
    },
  });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-user-service:${sha}`));
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-chat-service:${sha}`));
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-notification-service:${sha}`));
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-nginx:${sha}`));
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\\.current=ghcr\\.io/acme/chat-user-service:${sha}$`, 'm'));
  assert.match(next, new RegExp(`^user\\.previous=ghcr\\.io/acme/chat-user-service:${olderSha}$`, 'm'));
  assert.match(next, new RegExp(`^nginx\\.current=ghcr\\.io/acme/chat-nginx:${sha}$`, 'm'));
  assert.match(next, new RegExp(`^nginx\\.previous=ghcr\\.io/acme/chat-nginx:${olderSha}$`, 'm'));
});

test('production health parser rejects unhealthy instead of substring-matching healthy', async () => {
  const h = await harness({
    state: stateFor(),
    extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '', FAKE_HEALTH_STATUS: 'unhealthy' },
  });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /health check failed/i);
});

test('production health checks probe each public nginx route', async () => {
  const h = await harness({ state: stateFor(), extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '' } });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const curlLog = await readFile(path.join(h.root, 'curl.log'), 'utf8');
  for (const route of ['/api/user/health', '/chat/health', '/notifications/health']) {
    assert.match(curlLog, new RegExp(`-k -H Host: chat\\.ctaprojects\\.xyz https://localhost${route.replaceAll('/', '\\/')}$`, 'm'));
  }
});

test('release verifies every running container has its exact expected image', async () => {
  const h = await harness({
    state: stateFor(),
    extraEnv: {
      RUNTIME_USER_IMAGE: `ghcr.io/acme/chat-user-service:${oldSha}`,
    },
  });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /running image|rollback/i);
});

test('release grant SQL mirrors the least-privilege grant script', async () => {
  const release = await readFile(script, 'utf8');
  const grants = await readFile(path.join(repo, 'scripts/grant-service-privileges.sql'), 'utf8');
  for (const statement of [
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM user_svc, chat_svc, notif_svc',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM user_svc, chat_svc, notif_svc',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM user_svc, chat_svc, notif_svc',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO chat_svc',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO notif_svc',
  ]) {
    assert.match(grants, new RegExp(statement));
    assert.match(release, new RegExp(statement));
  }
  assert.doesNotMatch(release, /GRANT USAGE,SELECT ON ALL SEQUENCES/);
});

test('same generation is reconciled when runtime health is not healthy', async () => {
  const h = await harness({ state: stateFor() });
  assert.equal(run(h.env).status, 0);
  await writeFile(h.log, '');
  const result = run({ ...h.env, RELEASE_HEALTHCHECK_COMMAND: 'false' });
  assert.notEqual(result.status, 0);
  assert.notEqual(await readFile(h.log, 'utf8'), '');
});

test('partial current state is rejected before Docker mutation', async () => {
  const h = await harness({ state: `user.current=ghcr.io/acme/chat-user-service:${oldSha}\n` });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /coherent|complete|current/i);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('health validation checks every owned service', async () => {
  const h = await harness({
    state: stateFor(),
    extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '[ "$RELEASE_HEALTH_SERVICE" != chat ]' },
  });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /chat/);
});

test('health polling waits for a starting service to become healthy', async () => {
  const h = await harness({
    state: stateFor(),
    extraEnv: {
      RELEASE_HEALTHCHECK_COMMAND: 'n=$(cat "$HEALTH_COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$HEALTH_COUNTER"; test "$n" -ge 2',
      RELEASE_HEALTH_TIMEOUT: '2',
      RELEASE_POLL_INTERVAL: '0',
      RELEASE_HEALTH_MAX_ATTEMPTS: '10',
      HEALTH_COUNTER: path.join((await mkdtemp(path.join(os.tmpdir(), 'health-counter-'))), 'count'),
    },
  });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('compose keeps the admin password as a placeholder and grants service tables after migrations', async () => {
  const h = await harness({ state: stateFor() });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /test-only-secret/);
  assert.match(compose, /POSTGRES_PASSWORD: \$\{ADMIN_PASSWORD/);
  assert.match(compose, /\$\{ADMIN_PASSWORD:\?ADMIN_PASSWORD is required\}/);
  const log = await readFile(h.log, 'utf8');
  assert.match(log, /GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc/);
  assert.match(log, /GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO chat_svc/);
  assert.match(log, /GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO notif_svc/);
  assert.match(log, /docker network inspect n8n_nginx_bridge/);
  assert.equal(await readdir(path.join(h.root, 'chat-microservices/certbot/conf')).then(() => true), true);
  assert.equal(await readdir(path.join(h.root, 'chat-microservices/certbot/www')).then(() => true), true);
});

test('postgres readiness is bounded and provisioning follows a transient not-ready result', async () => {
  const h = await harness({
    state: stateFor(),
    dockerBody: `
if [ "$1" = compose ] && echo "$*" | grep -q 'exec -T postgres pg_isready'; then
  n=$(cat "$PG_READY_COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$PG_READY_COUNTER"
  if [ "$n" -eq 1 ]; then exit 91; fi
fi
`,
    extraEnv: {
      RELEASE_POLL_INTERVAL: '0',
      RELEASE_DB_READY_TIMEOUT: '2',
      RELEASE_DB_READY_MAX_ATTEMPTS: '5',
      PG_READY_COUNTER: path.join((await mkdtemp(path.join(os.tmpdir(), 'pg-ready-'))), 'count'),
    },
  });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const log = await readFile(h.log, 'utf8');
  const ready = log.indexOf('pg_isready');
  const provision = log.indexOf('psql');
  assert.ok(ready >= 0 && provision > ready, log);
});

test('duplicate owned state keys are canonicalized while unowned lines remain', async () => {
  const one = stateFor();
  const duplicate = one.replace(/\ncustom\.owner/, `\nuser.current=ghcr.io/acme/chat-user-service:${oldSha}\ncustom.owner`)
    .replace(/\ncustom\.owner/, `\nuser.previous=ghcr.io/acme/chat-user-service:${olderSha}\ncustom.owner`);
  const h = await harness({ state: duplicate });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  for (const key of ['user.current', 'user.previous']) assert.equal((next.match(new RegExp(`^${key}=`, 'gm')) || []).length, 1, next);
  assert.match(next, /^custom\.owner=preserved$/m);
});

const hasRealFlock = spawnSync('sh', ['-c', 'command -v flock >/dev/null 2>&1']).status === 0;
test('real flock serializes concurrent releases when available', { skip: !hasRealFlock }, async () => {
  const h = await harness({ state: stateFor(), realFlock: true, dockerBody: `
if [ "$1" = compose ]; then
  if ! mkdir "$FAKE_ACTIVE" 2>/dev/null; then exit 91; fi
  sleep 0.15
  rmdir "$FAKE_ACTIVE"
fi
` });
  h.env.FAKE_ACTIVE = path.join(h.root, 'active');
  const runAsync = () => new Promise(resolve => {
    const child = spawn('bash', [script], { cwd: repo, env: h.env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', status => resolve({ status, output }));
  });
  const [first, second] = await Promise.all([runAsync(), runAsync()]);
  assert.equal(first.status, 0, first.output);
  assert.equal(second.status, 0, second.output);
});
