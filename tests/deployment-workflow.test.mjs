import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const script = path.join(repo, 'deploy/release-backend.sh');
const verifier = path.join(repo, 'scripts/verify-deployment-workflow.mjs');
const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);

async function harness({ state = '', dockerBody = '', extraEnv = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backend-release-'));
  const bin = path.join(root, 'bin');
  await (await import('node:fs/promises')).mkdir(bin);
  const log = path.join(root, 'docker.log');
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\n' "docker $*" >> "$FAKE_DOCKER_LOG"
${dockerBody}
exit 0
`);
  await writeFile(path.join(bin, 'flock'), '#!/bin/sh\nprintf "%s\\n" "flock $*" >> "$FAKE_FLOCK_LOG"\nexit 0\n');
  await chmod(path.join(bin, 'docker'), 0o755);
  await chmod(path.join(bin, 'flock'), 0o755);
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
    DATABASE_URL_USER: 'postgresql://user_svc:test@postgres:5432/chat_db',
    DATABASE_URL_CHAT: 'postgresql://chat_svc:test@postgres:5432/chat_db',
    DATABASE_URL_NOTIFICATION: 'postgresql://notif_svc:test@postgres:5432/chat_db',
    RELEASE_HEALTHCHECK_COMMAND: 'true',
    RELEASE_POLL_INTERVAL: '0',
    FAKE_DOCKER_LOG: log,
    FAKE_FLOCK_LOG: path.join(root, 'flock.log'),
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
    `user.previous=ghcr.io/acme/chat-user-service:${oldSha}`,
    `chat.current=ghcr.io/acme/chat-chat-service:${ref}`,
    `chat.previous=ghcr.io/acme/chat-chat-service:${oldSha}`,
    `notification.current=ghcr.io/acme/chat-notification-service:${ref}`,
    `notification.previous=ghcr.io/acme/chat-notification-service:${oldSha}`,
    `nginx.current=ghcr.io/acme/chat-nginx:${ref}`,
    `nginx.previous=ghcr.io/acme/chat-nginx:${oldSha}`,
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
  const names = await (await import('node:fs/promises')).readdir(path.join(h.root, 'chat-microservices'));
  assert.equal(names.filter(name => name.includes('.tmp.')).length, 0);
});

test('health failure rolls back to exact previous refs and restores state', async () => {
  const h = await harness({ state: stateFor(), extraEnv: { RELEASE_HEALTHCHECK_COMMAND: 'false', RELEASE_ROLLBACK_HEALTHCHECK_COMMAND: 'true' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  const compose = await readFile(path.join(h.root, 'chat-microservices/backend.compose.yml'), 'utf8');
  assert.match(compose, new RegExp(`ghcr\\.io/acme/chat-user-service:${oldSha}`));
  const next = await readFile(path.join(h.root, 'release-state.env'), 'utf8');
  assert.match(next, new RegExp(`^user\.current=ghcr\\.io/acme/chat-user-service:${oldSha}$`, 'm'));
  assert.match(next, new RegExp(`^user\.previous=ghcr\\.io/acme/chat-user-service:${sha}$`, 'm'));
});

test('health failure without a recorded previous ref fails closed', async () => {
  const state = [
    `user.current=ghcr.io/acme/chat-user-service:${oldSha}`,
    `chat.current=ghcr.io/acme/chat-chat-service:${oldSha}`,
    `notification.current=ghcr.io/acme/chat-notification-service:${oldSha}`,
    `nginx.current=ghcr.io/acme/chat-nginx:${oldSha}`,
    '',
  ].join('\n');
  const h = await harness({ state, extraEnv: { RELEASE_HEALTHCHECK_COMMAND: 'false' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /previous/i);
});

test('injected atomic state-write failure leaves the original state untouched', async () => {
  const initial = stateFor();
  const h = await harness({ state: initial, extraEnv: { RELEASE_FAIL_STATE_WRITE: '1' } });
  const result = run(h.env);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(h.root, 'release-state.env'), 'utf8'), initial);
  assert.equal(await readFile(h.log, 'utf8').catch(() => ''), '');
});
