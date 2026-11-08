import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { verifyReleaseContractPair } from '../scripts/verify-release-contract-pair.mjs'

const backendPaths = ['chat-service/openapi.json', 'user-service/openapi.json']
const frontendPaths = ['contracts/chat-service.openapi.json', 'contracts/user-service.openapi.json',
  'contracts/source.json', 'src/lib/generated/api.operations.ts', 'src/lib/generated/api.types.ts']
const manifestPath = 'contracts/contract-snapshot.manifest.json'
const script = resolve(import.meta.dirname, '../scripts/verify-release-contract-pair.mjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const head = root => git(root, 'rev-parse', 'HEAD').trim()
function write(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), bytes)
}
const json = (root, path, value) => write(root, path, JSON.stringify(value, null, 2) + '\n')
const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
function commit(root) {
  git(root, 'add', '-A')
  git(root, 'commit', '--allow-empty', '-qm', 'fixture')
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-contract-pair-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const backendDir = join(root, 'backend')
  const frontendDir = join(root, 'frontend')
  for (const dir of [backendDir, frontendDir]) {
    mkdirSync(dir)
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.name', 'Contract fixture')
    git(dir, 'config', 'user.email', 'fixture@example.invalid')
    git(dir, 'config', 'commit.gpgSign', 'false')
  }
  for (const path of backendPaths) write(backendDir, path, JSON.stringify({ openapi: '3.0.0', info: { title: path }, paths: {} }))
  commit(backendDir)
  const backendSources = Object.fromEntries(backendPaths.map(path => [path, hash(readFileSync(join(backendDir, path)))]))
  const source = { backendCommit: head(backendDir), generatorVersion: 1, backendSources }
  for (const path of backendPaths) json(frontendDir, 'contracts/' + path.replace('/openapi.json', '.openapi.json'), readJson(backendDir, path))
  json(frontendDir, 'contracts/source.json', source)
  write(frontendDir, 'src/lib/generated/api.operations.ts', '// fixture operations\n')
  write(frontendDir, 'src/lib/generated/api.types.ts', '// fixture types\n')
  refreshManifest(frontendDir)
  commit(frontendDir)
  return { backendDir, frontendDir }
}

function refreshManifest(frontendDir) {
  const source = readJson(frontendDir, 'contracts/source.json')
  json(frontendDir, manifestPath, {
    schemaVersion: 1, ...source,
    frontendArtifacts: Object.fromEntries(frontendPaths.map(path => [path, hash(readFileSync(join(frontendDir, path)))]))
  })
}

test('accepts a clean committed pair and returns both exact HEADs without mutation', t => {
  const pair = fixture(t)
  write(pair.backendDir, 'unrelated.txt', 'unrelated dirty file')
  const result = verifyReleaseContractPair(pair)
  assert.equal(result.backendCommit, head(pair.backendDir))
  assert.equal(result.frontendCommit, head(pair.frontendDir))
  assert.equal(git(pair.frontendDir, 'status', '--porcelain'), '')
  assert.equal(readFileSync(join(pair.backendDir, 'unrelated.txt'), 'utf8'), 'unrelated dirty file')
})

test('requires both explicit CLI directories and accepts either argument order', t => {
  const pair = fixture(t)
  for (const args of [[], ['--backend-dir', pair.backendDir], ['--frontend-dir', pair.frontendDir],
    ['--backend-dir', pair.backendDir, '--unknown', pair.frontendDir]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
  }
  const result = spawnSync(process.execPath, [script, '--frontend-dir', pair.frontendDir, '--backend-dir', pair.backendDir], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(head(pair.backendDir)))
  assert.throws(() => verifyReleaseContractPair({ backendDir: pair.backendDir }), /frontendDir/)
})

test('rejects a changed backend with an internally consistent stale frontend snapshot', t => {
  const pair = fixture(t)
  json(pair.backendDir, backendPaths[0], { openapi: '3.0.0', paths: { '/new': {} } })
  commit(pair.backendDir)
  assert.throws(() => verifyReleaseContractPair(pair), /backendCommit/)
})

test('rejects an older backend commit even when both raw contract hashes still match', t => {
  const pair = fixture(t)
  git(pair.backendDir, 'commit', '--allow-empty', '-qm', 'new HEAD, same contracts')
  assert.throws(() => verifyReleaseContractPair(pair), /backendCommit/)
})

test('rejects stale raw backend hashes even when metadata names current HEAD', t => {
  const pair = fixture(t)
  write(pair.backendDir, backendPaths[0], readFileSync(join(pair.backendDir, backendPaths[0]), 'utf8') + '\n')
  commit(pair.backendDir)
  const source = readJson(pair.frontendDir, 'contracts/source.json')
  source.backendCommit = head(pair.backendDir)
  json(pair.frontendDir, 'contracts/source.json', source)
  refreshManifest(pair.frontendDir)
  commit(pair.frontendDir)
  assert.throws(() => verifyReleaseContractPair(pair), /backendSources.*hash/)
})

test('rejects a changed copied contract even when its manifest hash is updated', t => {
  const pair = fixture(t)
  json(pair.frontendDir, frontendPaths[0], { openapi: '3.0.0', paths: { '/wrong': {} } })
  refreshManifest(pair.frontendDir)
  commit(pair.frontendDir)
  assert.throws(() => verifyReleaseContractPair(pair), /copied contract/)
})

for (const mutation of [
  ['malformed JSON', root => write(root, 'contracts/source.json', '{')],
  ['source structure', root => json(root, 'contracts/source.json', [])],
  ['manifest schema', root => { const m = readJson(root, manifestPath); m.schemaVersion = 2; json(root, manifestPath, m) }],
  ['inconsistent commit', root => { const m = readJson(root, manifestPath); m.backendCommit = 'f'.repeat(40); json(root, manifestPath, m) }],
  ['inconsistent hashes', root => { const m = readJson(root, manifestPath); m.backendSources[backendPaths[0]] = 'f'.repeat(64); json(root, manifestPath, m) }],
  ['unknown manifest path', root => { const m = readJson(root, manifestPath); m.frontendArtifacts['../outside'] = 'f'.repeat(64); json(root, manifestPath, m) }],
  ['generator version', root => { const s = readJson(root, 'contracts/source.json'); s.generatorVersion = 2; json(root, 'contracts/source.json', s) }]
]) {
  test('rejects metadata: ' + mutation[0], t => {
    const pair = fixture(t)
    mutation[1](pair.frontendDir)
    commit(pair.frontendDir)
    assert.throws(() => verifyReleaseContractPair(pair), /JSON|keys|schemaVersion|backendCommit|backendSources|generatorVersion/)
  })
}

for (const side of ['backend', 'frontend']) {
  for (const state of ['dirty', 'staged', 'missing', 'symlink', 'untracked', 'staged-only']) {
    test(`rejects ${side} ${state} required artifact`, t => {
      const pair = fixture(t)
      const root = pair[side + 'Dir']
      const path = side === 'backend' ? backendPaths[0] : frontendPaths[0]
      if (state === 'dirty' || state === 'staged' || state === 'staged-only') write(root, path, '{}\n')
      if (state === 'staged' || state === 'staged-only') git(root, 'add', '--', path)
      if (state === 'staged-only') writeFileSync(join(root, path), execFileSync('git', ['show', 'HEAD:' + path], { cwd: root }))
      if (state === 'missing') unlinkSync(join(root, path))
      if (state === 'symlink') {
        write(root, 'target.json', readFileSync(join(root, path)))
        unlinkSync(join(root, path))
        symlinkSync(join(root, 'target.json'), join(root, path))
        commit(root)
      }
      if (state === 'untracked') {
        const original = readFileSync(join(root, path))
        git(root, 'rm', '--', path)
        commit(root)
        write(root, path, original)
      }
      assert.throws(() => verifyReleaseContractPair(pair), /dirty|committed bytes|regular|missing|tracked/)
    })
  }
}

test('rejects stale hashes for each of the five frontend artifacts', t => {
  for (const path of frontendPaths) {
    const pair = fixture(t)
    write(pair.frontendDir, path, readFileSync(join(pair.frontendDir, path), 'utf8') + '\n')
    commit(pair.frontendDir)
    assert.throws(() => verifyReleaseContractPair(pair), /frontendArtifacts.*hash/)
  }
})

for (const side of ['backend', 'frontend']) {
  test(`rejects ${side} HEAD movement during verification`, t => {
    const pair = fixture(t)
    let moved = false
    const run = (command, args, options) => {
      const result = execFileSync(command, args, options)
      if (!moved && options.cwd === realpathSync(pair.frontendDir) && args[0] === 'show') {
        moved = true
        git(pair[side + 'Dir'], 'commit', '--allow-empty', '-qm', 'HEAD moved')
      }
      return result
    }
    assert.throws(() => verifyReleaseContractPair({ ...pair, run }), /HEAD moved/)
    assert.equal(moved, true)
  })
}
