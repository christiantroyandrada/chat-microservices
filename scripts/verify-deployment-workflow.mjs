import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ci = await readFile(path.join(root, '.github/workflows/ci-main.yml'), 'utf8');
const deploy = await readFile(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
const release = await readFile(path.join(root, 'deploy/release-backend.sh'), 'utf8');

function requireText(source, pattern, message) {
  assert.match(source, pattern, message);
}

requireText(ci, /uses:\s+\.\/\.github\/workflows\/deploy\.yml/, 'main CI must call the reusable release workflow');
requireText(ci, /id:\s*build-user/, 'main CI must give user-service build an id');
requireText(ci, /id:\s*build-chat/, 'main CI must give chat-service build an id');
requireText(ci, /id:\s*build-notification/, 'main CI must give notification-service build an id');
requireText(ci, /id:\s*build-nginx/, 'main CI must give nginx build an id');
requireText(ci, /outputs:\s*\n[\s\S]*?user_digest:\s*\$\{\{\s*steps\.build-user\.outputs\.digest\s*\}\}/, 'main CI must export user-service digest');
requireText(ci, /chat_digest:\s*\$\{\{\s*steps\.build-chat\.outputs\.digest\s*\}\}/, 'main CI must export chat-service digest');
requireText(ci, /notification_digest:\s*\$\{\{\s*steps\.build-notification\.outputs\.digest\s*\}\}/, 'main CI must export notification-service digest');
requireText(ci, /nginx_digest:\s*\$\{\{\s*steps\.build-nginx\.outputs\.digest\s*\}\}/, 'main CI must export nginx digest');
requireText(ci, /with:\s*\n\s*user_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.user_digest\s*\}\}/, 'main CI must pass user digest to deploy');
requireText(ci, /chat_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.chat_digest\s*\}\}/, 'main CI must pass chat digest to deploy');
requireText(ci, /notification_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.notification_digest\s*\}\}/, 'main CI must pass notification digest to deploy');
requireText(ci, /nginx_digest:\s*\$\{\{\s*needs\.docker-build\.outputs\.nginx_digest\s*\}\}/, 'main CI must pass nginx digest to deploy');
assert.doesNotMatch(ci, /image_tag:\s*\$\{\{\s*github\.sha\s*\}\}/, 'main CI must not pass image_tag SHA');
requireText(ci, /node --test tests\/deployment-workflow\.test\.mjs/, 'main CI must run deployment workflow tests');
requireText(ci, /node scripts\/verify-deployment-workflow\.mjs/, 'main CI must run the deployment verifier');
requireText(ci, /node --test tests\/migration-policy\.test\.mjs/, 'main CI must run migration policy tests');
requireText(ci, /node scripts\/verify-migration-policy\.mjs/, 'main CI must verify migration policy before deployment');
assert.doesNotMatch(ci.slice(ci.indexOf('\n  deploy:')), /appleboy\/ssh-action|script:\s*\|/, 'main CI must not embed remote deploy code');

requireText(deploy, /workflow_call:/, 'release workflow must support workflow_call');
assert.doesNotMatch(deploy, /workflow_dispatch:/, 'release workflow must not support manual dispatch');
assert.doesNotMatch(deploy, /image_tag:/, 'release workflow must not accept image_tag');
requireText(deploy, /user_digest:[\s\S]*required:\s*true/, 'release must require user_digest');
requireText(deploy, /chat_digest:[\s\S]*required:\s*true/, 'release must require chat_digest');
requireText(deploy, /notification_digest:[\s\S]*required:\s*true/, 'release must require notification_digest');
requireText(deploy, /nginx_digest:[\s\S]*required:\s*true/, 'release must require nginx_digest');
requireText(deploy, /actions\/checkout@[0-9a-f]{40}/, 'release workflow must checkout an exact revision');
assert.doesNotMatch(deploy, /ref:\s*\$\{\{\s*inputs\.image_tag\s*\}\}/, 'release checkout must not be bound to image_tag');
requireText(deploy, /appleboy\/ssh-action@[0-9a-f]{40}/, 'SSH action must remain pinned');
requireText(deploy, /script_path:\s*deploy\/release-backend\.sh/, 'SSH action must invoke the checked-out script');
requireText(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-user-service@\$\{\{\s*inputs\.user_digest\s*\}\}/, 'release must construct user-service digest ref');
requireText(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-chat-service@\$\{\{\s*inputs\.chat_digest\s*\}\}/, 'release must construct chat-service digest ref');
requireText(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-notification-service@\$\{\{\s*inputs\.notification_digest\s*\}\}/, 'release must construct notification-service digest ref');
requireText(deploy, /ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/chat-nginx@\$\{\{\s*inputs\.nginx_digest\s*\}\}/, 'release must construct nginx digest ref');
requireText(deploy, /name:\s*Verify migration policy[\s\S]*node scripts\/verify-migration-policy\.mjs/, 'manual release must verify migration policy before SSH');
requireText(deploy, /MIGRATIONS_ROLLBACK_SAFE:\s*['"]true['"]/, 'manual release must pass the verified migration flag');
requireText(deploy, /envs:.*MIGRATIONS_ROLLBACK_SAFE/, 'SSH must receive the verified migration flag');
assert.doesNotMatch(deploy, /chat-frontend|frontend:|:latest\b/, 'release workflow must not consume mutable or unowned images');
assert.doesNotMatch(deploy, /reason:/, 'release workflow must not expose manual reason input');

requireText(release, /LOCK_PATH="\$\{RELEASE_LOCK_PATH:-\/opt\/chat-app\/\.release\.lock\}"/, 'release must use the shared host lock');
requireText(release, /flock -x 9/, 'release must acquire an exclusive lock');
requireText(release, /backend\.compose\.yml/, 'release must use the backend compose file');
requireText(release, /release-state\.env/, 'release must use shared release state');
requireText(release, /\.tmp\.\$\$/, 'release state and compose updates need same-directory temporary files');
requireText(release, /mv -f/, 'atomic updates must use rename');
requireText(release, /user chat notification nginx/, 'release must operate only owned services');
requireText(release, /PREVIOUS_USER|PREVIOUS_CHAT|PREVIOUS_NOTIFICATION|PREVIOUS_NGINX/, 'rollback must use recorded previous refs');
requireText(release, /CURRENT_USER|CURRENT_CHAT|CURRENT_NOTIFICATION|CURRENT_NGINX/, 'rollback must use the pre-deploy current generation');
requireText(release, /healthcheck:/, 'owned services must define health checks');
requireText(release, /build\/src\/migrate\.js/, 'release must run application migrations');
requireText(release, /provision_database/, 'release must provision service database roles idempotently');
requireText(release, /wait_for_postgres|pg_isready/, 'release must wait for postgres readiness before provisioning');
requireText(release, /JWT_SECRET_FILE|\.jwt_secret/, 'release must preserve the persistent JWT secret');
requireText(release, /export JWT_SECRET/, 'Compose must inherit the persistent JWT secret');
requireText(release, /certbot\/conf|certbot\/www/, 'release must preserve certificate mounts');
requireText(release, /docker network inspect n8n_nginx_bridge/, 'release must verify the shared bridge network');
requireText(release, /docker network create n8n_nginx_bridge/, 'release must create the shared bridge network when absent');
requireText(release, /mkdir -p .*certbot\/conf.*certbot\/www/, 'release must create certificate mount directories');
requireText(release, /GRANT SELECT,\s*INSERT,\s*UPDATE,\s*DELETE ON users, prekeys TO user_svc/, 'release must restore user table grants');
requireText(release, /GRANT SELECT,\s*INSERT,\s*UPDATE,\s*DELETE ON messages TO chat_svc/, 'release must restore chat table grants');
requireText(release, /GRANT SELECT,\s*INSERT,\s*UPDATE,\s*DELETE ON notifications TO notif_svc/, 'release must restore notification table grants');
requireText(release, /RELEASE_HEALTH_TIMEOUT|RELEASE_HEALTH_MAX_ATTEMPTS/, 'health checks must be bounded and poll');
requireText(release, /docker pull "\$USER_IMAGE_REF"/, 'release must pull immutable candidate images directly');
requireText(release, /docker pull "\$CHAT_IMAGE_REF"/, 'release must pull the chat candidate image');
requireText(release, /docker pull "\$NOTIFICATION_IMAGE_REF"/, 'release must pull the notification candidate image');
requireText(release, /docker pull "\$NGINX_IMAGE_REF"/, 'release must pull the nginx candidate image');
requireText(release, /docker run --rm --env MESSAGE_BROKER_URL "\$CHAT_IMAGE_REF" build\/src\/preflight\/brokerPreflight\.js/, 'broker preflight must run inside the immutable candidate chat image without printing the URL');
requireText(release, /MIGRATIONS_ROLLBACK_SAFE:-.*== "true"/, 'release must require an explicitly verified migration flag');
requireText(release, /PENDING_STATE_FILE/, 'release must prepare non-authoritative pending state');
requireText(release, /@sha256:/, 'release must use digest-qualified references');
assert.doesNotMatch(release, /chat-user-service:\$IMAGE_TAG/, 'release must not use tag fallback');
assert.doesNotMatch(release, /\$IMAGE_TAG/, 'release must not reference IMAGE_TAG');
requireText(release, /REPO_OWNER.*@sha256:/, 'release must validate digest refs');
const releaseFlow = release.slice(release.lastIndexOf('if ! pull_images'));
for (const [earlier, later] of [
  ['pull_images', 'run_broker_preflight'],
  ['run_broker_preflight', 'MIGRATIONS_ROLLBACK_SAFE'],
  ['MIGRATIONS_ROLLBACK_SAFE', 'deploy_candidate'],
]) {
  const a = releaseFlow.indexOf(earlier);
  const b = releaseFlow.indexOf(later);
  assert.ok(a >= 0 && b >= 0, `${earlier} and ${later} must exist`);
  assert.ok(a < b, `${earlier} must precede ${later}`);
}
const candidateFlow = release.slice(release.indexOf('deploy_candidate()'), release.indexOf('\nrollback()'));
for (const [earlier, later] of [
  ['write_pending_state', 'run_migrations'],
  ['run_migrations', 'up -d --no-deps user chat notification nginx'],
  ['up -d --no-deps user chat notification nginx', 'verify_running_images'],
  ['verify_running_images', 'health_check'],
  ['health_check', 'write_state'],
]) {
  const a = candidateFlow.indexOf(earlier);
  const b = candidateFlow.indexOf(later);
  assert.ok(a >= 0 && b >= 0, `${earlier} and ${later} must exist`);
  assert.ok(a < b, `${earlier} must precede ${later}`);
}
const rollback = release.slice(release.indexOf('rollback()'), release.lastIndexOf('if ! pull_images'));
assert.doesNotMatch(rollback, /write_state/, 'rollback must preserve authoritative release state');
assert.doesNotMatch(release, /DROP\s+SCHEMA|docker\s+system\s+prune/, 'release must not destructively reset the database or global Docker state');
assert.doesNotMatch(release, /(^|[^A-Za-z])frontend([^A-Za-z]|$)|docker\s+(volume|container)\s+prune|docker\s+image\s+prune/, 'release must not alter unowned services or prune shared state');

console.log('deployment workflow verification passed');
