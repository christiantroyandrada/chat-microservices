import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const verifier = path.join(repo, 'scripts/verify-migration-policy.mjs');
const migrationPath = 'chat-service/src/database/migrations/1-Initial.ts';
const migration = 'export class Initial {}\n';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture({ manifest = null, content = migration } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'migration-policy-'));
  await mkdir(path.join(root, path.dirname(migrationPath)), { recursive: true });
  await mkdir(path.join(root, 'deploy'), { recursive: true });
  await writeFile(path.join(root, migrationPath), content);
  await writeFile(path.join(root, 'deploy/migration-policy.json'), JSON.stringify(manifest ?? {
    migrations: [{ path: migrationPath, sha256: sha256(content), classification: 'backward-compatible' }],
  }));
  return root;
}

function verify(root) {
  return spawnSync(process.execPath, [verifier], {
    cwd: repo,
    env: { ...process.env, MIGRATION_POLICY_ROOT: root },
    encoding: 'utf8',
  });
}

test('accepts the exact current migration inventory', () => {
  const result = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects missing, extra, and changed migration entries', async t => {
  await t.test('missing', async () => {
    const root = await fixture({ manifest: { migrations: [] } });
    assert.notEqual(verify(root).status, 0);
  });
  await t.test('extra', async () => {
    const root = await fixture({ manifest: { migrations: [
      { path: migrationPath, sha256: sha256(migration), classification: 'backward-compatible' },
      { path: 'user-service/src/database/migrations/stale.ts', sha256: sha256('stale'), classification: 'backward-compatible' },
    ] } });
    assert.notEqual(verify(root).status, 0);
  });
  await t.test('changed hash', async () => {
    const root = await fixture({
      content: `${migration}// changed\n`,
      manifest: { migrations: [{ path: migrationPath, sha256: sha256(migration), classification: 'backward-compatible' }] },
    });
    assert.notEqual(verify(root).status, 0);
  });
});

test('rejects malformed or unsafe automatic-release classifications', async t => {
  for (const classification of ['safe', 'forward-only', null]) {
    await t.test(String(classification), async () => {
      const root = await fixture({ manifest: { migrations: [{ path: migrationPath, sha256: sha256(migration), classification }] } });
      assert.notEqual(verify(root).status, 0);
    });
  }
});
