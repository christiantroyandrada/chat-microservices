import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.env.MIGRATION_POLICY_ROOT || path.resolve(import.meta.dirname, '..'));
const manifestPath = path.join(root, 'deploy/migration-policy.json');

function fail(message) {
  throw new Error(message);
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.migrations)) {
    fail('manifest must contain only a migrations array');
  }
  const entries = new Map();
  for (const entry of value.migrations) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3 ||
      typeof entry.path !== 'string' || !/^[a-z0-9-]+\/src\/database\/migrations\/[^/]+\.ts$/.test(entry.path) ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.classification !== 'backward-compatible') {
      fail('manifest entry is invalid or not backward-compatible');
    }
    if (entries.has(entry.path)) fail(`duplicate manifest entry: ${entry.path}`);
    entries.set(entry.path, entry.sha256);
  }
  return entries;
}

async function currentMigrations() {
  const entries = new Map();
  for (const service of await readdir(root, { withFileTypes: true })) {
    if (!service.isDirectory()) continue;
    const migrationDirectory = path.join(root, service.name, 'src/database/migrations');
    let migrations;
    try {
      migrations = await readdir(migrationDirectory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const migration of migrations) {
      if (!migration.isFile() || !migration.name.endsWith('.ts')) continue;
      const relativePath = path.posix.join(service.name, 'src/database/migrations', migration.name);
      entries.set(relativePath, createHash('sha256').update(await readFile(path.join(migrationDirectory, migration.name))).digest('hex'));
    }
  }
  return entries;
}

async function main() {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const migrations = await currentMigrations();
  if (manifest.size !== migrations.size) fail('manifest and migration inventory differ');
  for (const [migration, hash] of migrations) {
    if (manifest.get(migration) !== hash) fail(`manifest hash mismatch: ${migration}`);
  }
}

main().then(() => console.log('migration policy verification passed')).catch(error => {
  console.error(`migration policy verification failed: ${error.message}`);
  process.exitCode = 1;
});
