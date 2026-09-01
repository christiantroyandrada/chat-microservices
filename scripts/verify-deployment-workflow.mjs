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
assert.doesNotMatch(release, /(^|[^A-Za-z])frontend([^A-Za-z]|$)|docker\s+(volume|container)\s+prune|docker\s+image\s+prune/, 'release must not alter unowned services or prune shared state');

console.log('deployment workflow verification passed');
