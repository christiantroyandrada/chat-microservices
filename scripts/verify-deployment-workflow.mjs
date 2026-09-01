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
requireText(ci, /with:\s*\n\s*image_tag:\s*\$\{\{\s*github\.sha\s*\}\}/, 'main CI must pass its commit SHA');
requireText(ci, /node --test tests\/deployment-workflow\.test\.mjs/, 'main CI must run deployment workflow tests');
requireText(ci, /node scripts\/verify-deployment-workflow\.mjs/, 'main CI must run the deployment verifier');
assert.doesNotMatch(ci.slice(ci.indexOf('\n  deploy:')), /appleboy\/ssh-action|script:\s*\|/, 'main CI must not embed remote deploy code');

requireText(deploy, /workflow_call:/, 'release workflow must support workflow_call');
requireText(deploy, /workflow_dispatch:/, 'release workflow must support manual dispatch');
requireText(deploy, /image_tag:[\s\S]*required:\s*true/, 'manual release must require an image SHA');
requireText(deploy, /actions\/checkout@[0-9a-f]{40}/, 'release workflow must checkout an exact revision');
requireText(deploy, /appleboy\/ssh-action@[0-9a-f]{40}/, 'SSH action must remain pinned');
requireText(deploy, /script_path:\s*deploy\/release-backend\.sh/, 'SSH action must invoke the checked-out script');
assert.doesNotMatch(deploy, /chat-frontend|frontend:|:latest\b/, 'release workflow must not consume mutable or unowned images');

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
assert.doesNotMatch(release, /DROP\s+SCHEMA|docker\s+system\s+prune/, 'release must not destructively reset the database or global Docker state');
assert.doesNotMatch(release, /(^|[^A-Za-z])frontend([^A-Za-z]|$)|docker\s+(volume|container)\s+prune|docker\s+image\s+prune/, 'release must not alter unowned services or prune shared state');

console.log('deployment workflow verification passed');
