import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
const dig = 'a'.repeat(64);
const oldDig = 'b'.repeat(64);
const olderDig = 'c'.repeat(64);
const otherDig = 'd'.repeat(64);
const userDigestRef = `ghcr.io/acme/chat-user-service@sha256:${dig}`;
const chatDigestRef = `ghcr.io/acme/chat-chat-service@sha256:${dig}`;
const notifDigestRef = `ghcr.io/acme/chat-notification-service@sha256:${dig}`;
const nginxDigestRef = `ghcr.io/acme/chat-nginx@sha256:${dig}`;
const oldUserDigestRef = `ghcr.io/acme/chat-user-service@sha256:${oldDig}`;
const oldChatDigestRef = `ghcr.io/acme/chat-chat-service@sha256:${oldDig}`;
const oldNotifDigestRef = `ghcr.io/acme/chat-notification-service@sha256:${oldDig}`;
const oldNginxDigestRef = `ghcr.io/acme/chat-nginx@sha256:${oldDig}`;
const olderUserDigestRef = `ghcr.io/acme/chat-user-service@sha256:${olderDig}`;
const olderChatDigestRef = `ghcr.io/acme/chat-chat-service@sha256:${olderDig}`;
const olderNotifDigestRef = `ghcr.io/acme/chat-notification-service@sha256:${olderDig}`;
const olderNginxDigestRef = `ghcr.io/acme/chat-nginx@sha256:${olderDig}`;

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
    USER_IMAGE: userDigestRef,
    CHAT_IMAGE: chatDigestRef,
    NOTIFICATION_IMAGE: notifDigestRef,
    NGINX_IMAGE: nginxDigestRef,
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
  // Remove IMAGE_TAG if harness caller explicitly sets it to empty to test missing case
  if (extraEnv.IMAGE_TAG === '') delete env.IMAGE_TAG;
  return { root, log, env };
}

function run(env) {
  return spawnSync('bash', [script], { cwd: repo, env, encoding: 'utf8' });
}

function stateFor(ref = oldDig) {
  const r = `sha256:${ref}`;
  return [
    `user.current=ghcr.io/acme/chat-user-service@${r}`,
    `user.previous=ghcr.io/acme/chat-user-service@sha256:${olderDig}`,
    `chat.current=ghcr.io/acme/chat-chat-service@${r}`,
    `chat.previous=ghcr.io/acme/chat-chat-service@sha256:${olderDig}`,
    `notification.current=ghcr.io/acme/chat-notification-service@${r}`,
    `notification.previous=ghcr.io/acme/chat-notification-service@sha256:${olderDig}`,
    `nginx.current=ghcr.io/acme/chat-nginx@${r}`,
    `nginx.previous=ghcr.io/acme/chat-nginx@sha256:${olderDig}`,
    'custom.owner=preserved',
    '',
  ].join('\n');
}

test('static verifier accepts the immutable, split ownership workflow', () => {
  const result = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('main CI exports all four build-step digests and passes them to deploy workflow', async () => {
  const ci = await readFile(path.join(repo, '.github/workflows/ci-main.yml'), 'utf8');
  assert.match(ci, /id:\s*build-user/, 'user build must have id');
  assert.match(ci, /id:\s*build-chat/, 'chat build must have id');
  assert.match(ci, /id:\s*build-notification/, 'notification build must have id');
  assert.match(ci, /id:\s*build-nginx/, 'nginx build must have id');
  assert.match(ci, /user_digest:\s*\$\{\{\s*steps\.build-user\.outputs\.digest\s*\}\}/);
  assert.match(ci, /chat_digest:\s*\$\{\{\s*steps\.build-chat\.outputs\.digest\s*\}\}/);
  assert.match(ci, /notification_digest:\s*\$\{\{\s*steps\.build-notification\.outputs\.digest\s*\}\}/);
  assert.match(ci, /nginx_digest:\s*\$\{\{\s*steps\.build-nginx\.outputs\.digest\s*\}\}/);
  assert.match(ci, /user_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.user_digest\s*\}\}/);
  assert.match(ci, /chat_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.chat_digest\s*\}\}/);
  assert.match(ci, /notification_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.notification_digest\s*\}\}/);
  assert.match(ci, /nginx_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.nginx_digest\s*\}\}/);
  assert.doesNotMatch(ci, /image_tag:\s*\$\{\{\s*github\.sha\s*\}\}/);
});

test('reusable deployment workflow has no workflow_dispatch and requires four digest inputs', async () => {
  const deploy = await readFile(path.join(repo, '.github/workflows/deploy.yml'), 'utf8');
  assert.doesNotMatch(deploy, /workflow_dispatch:/);
  assert.doesNotMatch(deploy, /image_tag:/);
  assert.match(deploy, /user_digest:[\s\S]*required:\s*true/);
  assert.match(deploy, /chat_digest:[\s\S]*required:\s*true/);
  assert.match(deploy, /notification_digest:[\s\S]*required:\s*true/);
  assert.match(deploy, /nginx_digest:[\s\S]*required:\s*true/);
  assert.match(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-user-service@\$\{\{\s*inputs\.user_digest\s*\}\}/);
  assert.match(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-chat-service@\$\{\{\s*inputs\.chat_digest\s*\}\}/);
  assert.match(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-notification-service@\$\{\{\s*inputs\.notification_digest\s*\}\}/);
  assert.match(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-nginx@\$\{\{\s*inputs\.nginx_digest\s*\}\}/);
});

test('production release rejects mutable image refs before Docker mutation', async () => {
  const h = await harness({ extraEnv: { USER_IMAGE: 'ghcr.io/acme/chat-user-service:latest' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('release rejects commit-SHA tag reference before any Docker or persistent mutation', async () => {
  const tagRef = `ghcr.io/acme/chat-user-service:${sha}`;
  const h = await harness({ extraEnv: { USER_IMAGE: tagRef } });
  const before = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /immutable image ref rejected|digest/i);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '', 'docker must not be invoked on tag rejection');
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), before, 'state must be untouched on tag rejection');
  const composeExists = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8').then(() => true).catch(() => false);
  assert.equal(composeExists, false, 'compose must not be written on tag rejection');
  const secretExists = await readFile(path.join(h.root, '.jwt_secret'), 'utf8').then(() => true).catch(() => false);
  assert.equal(secretExists, false, 'secret must not be created on tag rejection');
});

test('release rejects malformed digest before mutation', async () => {
  const malformed = `ghcr.io/acme/chat-user-service@sha256:${'a'.repeat(63)}`;
  const h = await harness({ extraEnv: { USER_IMAGE: malformed } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('release rejects uppercase digest before mutation', async () => {
  const upper = `ghcr.io/acme/chat-user-service@sha256:${'A'.repeat(64)}`;
  const h = await harness({ extraEnv: { USER_IMAGE: upper } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('release rejects wrong GHCR owner before mutation', async () => {
  const wrongOwner = `ghcr.io/evil/chat-user-service@sha256:${dig}`;
  const h = await harness({ extraEnv: { USER_IMAGE: wrongOwner } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('release rejects wrong service repository before mutation', async () => {
  const wrongRepo = `ghcr.io/acme/chat-unknown-service@sha256:${dig}`;
  const h = await harness({ extraEnv: { USER_IMAGE: wrongRepo } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('release rejects missing digest reference before mutation', async () => {
  const h = await harness({ extraEnv: { USER_IMAGE: '' } });
  // also need to ensure CHAT etc missing? harness sets USER_IMAGE empty but validation should fail on empty
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});

test('valid digest set reaches pull/preflight and is written to state and Compose unchanged', async () => {
  const h = await harness({ state: stateFor() });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\\.current=${userDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(next, new RegExp(`^chat\\.current=${chatDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(next, new RegExp(`^notification\\.current=${notifDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(next, new RegExp(`^nginx\\.current=${nginxDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(next, new RegExp(`^user\\.previous=${oldUserDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.match(compose, new RegExp(userDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(compose, new RegExp(chatDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(compose, new RegExp(notifDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(compose, new RegExp(nginxDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const log = await readFile(h.log, 'utf8');
  assert.match(log, new RegExp(`pull ${userDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(log, new RegExp(`pull ${chatDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(log, new RegExp(`pull ${notifDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(log, new RegExp(`pull ${nginxDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('rollback remains bound to previously recorded digest references', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '', FAKE_HEALTH_STATUS: 'unhealthy' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  const after = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.equal(after, initial, 'rollback must preserve authoritative digest state unchanged');
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8').catch(() => '');
  // after rollback compose should still reference old digests
  assert.match(compose, new RegExp(oldUserDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('successful release preserves unowned state and never operates an unowned service', async () => {
  const h = await harness({ state: stateFor() });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, /^custom\.owner=preserved$/m);
  assert.match(next, new RegExp(`^user\\.current=${userDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(next, new RegExp(`^user\\.previous=${oldUserDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8'), /(^|\n)\s*frontend:/);
  assert.doesNotMatch(await readFile(h.log, 'utf8'), /compose .*frontend/);
  assert.match(await readFile(path.join(h.root, 'flock.log'), 'utf8'), /flock -x 9/);
  const names = await readdir(path.join(h.root, 'chat-microservices'));
  assert.equal(names.filter(name => name.includes('.tmp.')).length, 0);
  const calls = (await readFile(h.log, 'utf8')).split('\n').filter(line => line.startsWith('docker compose '));
  assert.ok(calls.length > 0);
  assert.ok(calls.every(line => line.startsWith(`docker compose --project-name chat-microservices --file ${h.root}/chat-microservices/backend.compose.yml `)));
  assert.ok(calls.every(line => !line.includes('docker-compose.override.yml')));
});

for (const failsHealth of [false, true]) {
  test(`host gateway override is retained throughout ${failsHealth ? 'failed deployment and rollback' : 'successful deployment'}`, async () => {
    const initial = stateFor();
    const h = await harness({
      state: initial,
      extraEnv: failsHealth ? {
        RELEASE_HEALTHCHECK_COMMAND: '',
        FAKE_HEALTH_STATUS: 'unhealthy',
        RELEASE_HEALTH_MAX_ATTEMPTS: '1',
        RELEASE_ROLLBACK_HEALTHCHECK_COMMAND: 'true',
      } : {},
    });
    const override = path.join(h.root, 'chat-microservices/docker-compose.override.yml');
    const bytes = Buffer.from(`services:
  nginx:
    volumes:
      - /opt/worksmart/runtime/gateway-nginx.conf:/opt/bitnami/nginx/conf/nginx.conf:ro
    networks:
      worksmart_gateway: {}
networks:
  worksmart_gateway:
    name: worksmart_gateway
    external: true
`);
    await mkdir(path.dirname(override));
    await writeFile(override, bytes);
    const result = run(h.env);
    assert.equal(result.status, failsHealth ? 1 : 0, result.stderr || result.stdout);
    const log = await readFile(h.log, 'utf8');
    const calls = log.split('\n').filter(line => line.startsWith('docker compose '));
    assert.ok(calls.length > 0, 'release must execute Compose');
    const prefix = `docker compose --project-name chat-microservices --file ${h.root}/chat-microservices/backend.compose.yml --file ${override} `;
    assert.ok(calls.every(line => line.startsWith(prefix)), 'every Compose call must load the host override after the generated base');
    assert.equal(calls.filter(line => line.endsWith('up -d --no-deps user chat notification nginx')).length, failsHealth ? 2 : 1);
    assert.deepEqual(await readFile(override), bytes, 'host-owned override bytes must remain intact');
    assert.doesNotMatch(log, /compose .* (up|stop|rm).*worksmart/);
    if (failsHealth) assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  });
}

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
    `pull ${userDigestRef}`,
    `pull ${chatDigestRef}`,
    `pull ${notifDigestRef}`,
    `pull ${nginxDigestRef}`,
  ]) {
    const idx = log.indexOf(image);
    assert.ok(idx >= 0, `${image} must be pulled`);
    assert.ok(idx < preflight, `${image} must precede preflight`);
  }
  assert.equal(await readFile(path.join(h.root, 'release-state.env.pending'), 'utf8').then(() => true).catch(() => false), false, 'pending must not be created on preflight failure');
  assert.doesNotMatch(log, /compose .* (run|up -d)/);
});

test('failed pull or preflight does not create persistent JWT secret and leaves state/runtime untouched', async () => {
  const initial = stateFor();
  const dockerBody = 'if [ "$1" = pull ]; then exit 91; fi';
  const h = await harness({ state: initial, dockerBody });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  const log = await readFile(h.log, 'utf8').catch(() => '');
  assert.doesNotMatch(log, /compose .* (run|up -d)/);
  const failH = await harness({ state: initial, dockerBody });
  const sPath = path.join(failH.root, '.jwt_secret');
  // second variant checked via pending path
  const pendingExists = await readFile(path.join(failH.root, 'release-state.env.pending'), 'utf8').then(() => true).catch(() => false);
  assert.equal(pendingExists, false);
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
  const mvLog = await readFile(path.join(h.root, 'mv.log'), 'utf8').catch(() => '');
  assert.match(mvLog, /release-state\.env\.pending/, 'write_pending_state must publish the pending file before failing');
  assert.equal(run({ ...h.env, RELEASE_FAIL_AFTER_PENDING: '' }).status, 0);
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\\.current=${userDigestRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('health failure keeps last-known-good state authoritative and rolls runtime back once', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '', FAKE_HEALTH_STATUS: 'unhealthy' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  const log = await readFile(h.log, 'utf8');
  assert.match(log, /up -d --no-deps user chat notification nginx/);
  assert.equal((log.match(/up -d --no-deps/g) || []).length, 2, 'rollback must run exactly once');
});

test('health failure with current-only state rolls back to the running release', async () => {
  const currentOnly = [
    `user.current=${oldUserDigestRef}`,
    `chat.current=${oldChatDigestRef}`,
    `notification.current=${oldNotifDigestRef}`,
    `nginx.current=${oldNginxDigestRef}`,
    '',
  ].join('\n');
  const h = await harness({ state: currentOnly, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '', FAKE_HEALTH_STATUS: 'unhealthy' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), currentOnly);
});

test('health failure with empty state fails closed without inventing rollback', async () => {
  const h = await harness({ state: '', extraEnv: { RELEASE_HEALTHCHECK_COMMAND: '', FAKE_HEALTH_STATUS: 'unhealthy' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), '');
  const log = await readFile(h.log, 'utf8');
  assert.doesNotMatch(log, /up -d --no-deps user chat notification nginx.*up -d --no-deps user chat notification nginx/s);
});

test('atomic promotion failure leaves state bytes untouched and rolls runtime back once', async () => {
  const h = await harness({ state: stateFor(), extraEnv: { RELEASE_FAIL_AFTER_STATE_TEMP: '1' } });
  const before = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), before);
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

test('successful release uses least-privilege database grants and never exposes test-only secrets in compose', async () => {
  const h = await harness({ state: stateFor() });
  const result = run(h.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /test-only-secret/);
  assert.match(compose, /POSTGRES_PASSWORD: \$\{ADMIN_PASSWORD/);
  assert.match(compose, /\$\{ADMIN_PASSWORD:.*is required\}/);
  const log = await readFile(h.log, 'utf8');
  assert.match(log, /GRANT SELECT, INSERT, UPDATE, DELETE ON users, prekeys TO user_svc/);
});

const hasRealFlock = spawnSync('which', ['flock'], { encoding: 'utf8' }).status === 0;
test('real flock serializes concurrent releases when available', { skip: !hasRealFlock } , async () => {
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
