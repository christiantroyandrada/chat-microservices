import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { verifyContractArtifacts } from '../scripts/verify-contract-artifacts.mjs'

const ARTIFACTS = ['user-service/openapi.json', 'chat-service/openapi.json']
const BACKEND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ORIGINAL = {
  'user-service/openapi.json': Buffer.from('{"service":"user","version":1}'),
  'chat-service/openapi.json': Buffer.from('{"service":"chat","version":1}'),
}

function command(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

function blobBytes(root, path) {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: null })
  assert.equal(result.status, 0, `git show ${path} failed: ${result.stderr?.toString()}`)
  return result.stdout
}

function assertArtifactBytes(root, expected = ORIGINAL) {
  for (const path of ARTIFACTS) {
    assert.deepEqual(readFileSync(join(root, path)), expected[path])
  }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'contract-verifier-test-'))
  command(root, ['init', '-q'])
  command(root, ['config', 'user.email', 'test@example.invalid'])
  command(root, ['config', 'user.name', 'Contract Verifier'])
  for (const path of ARTIFACTS) {
    const file = join(root, path)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, ORIGINAL[path])
  }
  writeFileSync(join(root, 'unrelated.txt'), Buffer.from('unrelated'))
  command(root, ['add', '--', ...ARTIFACTS, 'unrelated.txt'])
  command(root, ['commit', '-qm', 'fixture'])
  return root
}

function baseRunner(root, options = {}) {
  const calls = []
  const runner = (commandName, args, commandOptions) => {
    calls.push({ commandName, args: [...args], options: { ...commandOptions } })
    if (commandName === 'git') return spawnSync(commandName, args, commandOptions)
    if (commandName !== 'npm') throw new Error(`unexpected command ${commandName}`)
    const service = args[1]
    const marker = join(root, `${service}-generator-ran`)
    writeFileSync(marker, Buffer.from('ran'))
    options.onGenerate?.({ root, service, marker })
    return {
      status: options.status ?? 0,
      stdout: options.stdout ?? '',
      stderr: options.stderr ?? '',
      error: options.error,
      signal: options.signal ?? null,
    }
  }
  runner.calls = calls
  return runner
}

function runVerifier(root, runner = baseRunner(root)) {
  return verifyContractArtifacts({ repositoryRoot: root, run: runner })
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

test('verifies both clean artifacts twice from an unrelated cwd and returns pinned hashes', () => {
  const root = makeFixture()
  try {
    const runner = baseRunner(root, {
      onGenerate: ({ root: fixtureRoot, service }) => {
        const path = `${service}/openapi.json`
        writeFileSync(join(fixtureRoot, path), ORIGINAL[path])
      },
    })
    const previousCwd = process.cwd()
    process.chdir(tmpdir())
    try {
      const first = runVerifier(root, runner)
      const second = runVerifier(root, runner)
      assert.deepEqual(second, first)
      assert.equal(first.commit, command(root, ['rev-parse', 'HEAD']).stdout.trim())
      for (const path of ARTIFACTS) {
        const blob = blobBytes(root, path)
        assert.equal(first.hashes[path], createRequire(import.meta.url)('node:crypto').createHash('sha256').update(blob).digest('hex'))
        assert.deepEqual(readFileSync(join(root, path)), ORIGINAL[path])
      }
    } finally {
      process.chdir(previousCwd)
    }
    assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 4)
    for (const call of runner.calls.filter(({ commandName }) => commandName === 'npm')) {
      assert.deepEqual(call.args, ['--prefix', call.args[1], 'run', 'gen:spec'])
      assert.equal(call.options.cwd, root)
      assert.equal(call.options.encoding, 'utf8')
      assert.equal(call.options.shell, false)
    }
  } finally {
    cleanup(root)
  }
})

for (const artifact of ARTIFACTS) {
  test(`missing working-tree ${artifact} fails before either generator`, () => {
    const root = makeFixture()
    try {
      unlinkSync(join(root, artifact))
      const runner = baseRunner(root)
      assert.throws(() => runVerifier(root, runner), /regular|missing|working-tree/i)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
      assert.equal(readFileSync(join(root, 'unrelated.txt')).toString(), 'unrelated')
      for (const path of ARTIFACTS.filter((candidate) => candidate !== artifact)) {
        assert.deepEqual(readFileSync(join(root, path)), ORIGINAL[path])
      }
      assert.equal(existsSync(join(root, artifact)), false)
    } finally {
      cleanup(root)
    }
  })

  test(`committed deletion plus untracked replacement for ${artifact} fails before generation`, () => {
    const root = makeFixture()
    try {
      unlinkSync(join(root, artifact))
      command(root, ['add', '-u', '--', artifact])
      command(root, ['commit', '-qm', 'delete artifact'])
      writeFileSync(join(root, artifact), Buffer.from('untracked replacement'))
      const runner = baseRunner(root)
      assert.throws(() => runVerifier(root, runner), /HEAD|track|index|missing/i)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
      assert.deepEqual(readFileSync(join(root, artifact)), Buffer.from('untracked replacement'))
      for (const path of ARTIFACTS.filter((candidate) => candidate !== artifact)) {
        assert.deepEqual(readFileSync(join(root, path)), ORIGINAL[path])
      }
    } finally {
      cleanup(root)
    }
  })
}

test('rejects dirty staged or unstaged artifacts before either generator', () => {
  for (const state of ['unstaged', 'staged']) {
    const root = makeFixture()
    try {
      writeFileSync(join(root, ARTIFACTS[0]), Buffer.from(`dirty-${state}`))
      if (state === 'staged') command(root, ['add', '--', ARTIFACTS[0]])
      writeFileSync(join(root, 'unrelated.txt'), Buffer.from('unrelated dirty'))
      const runner = baseRunner(root)
      assert.throws(() => runVerifier(root, runner), /sha256 mismatch/)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
      assert.equal(readFileSync(join(root, 'unrelated.txt')).toString(), 'unrelated dirty')
      assertArtifactBytes(root, { ...ORIGINAL, [ARTIFACTS[0]]: Buffer.from(`dirty-${state}`) })
    } finally {
      cleanup(root)
    }
  }
})

test('allows unrelated dirty files while preserving both artifact bytes', () => {
  const root = makeFixture()
  try {
    writeFileSync(join(root, 'unrelated.txt'), Buffer.from('unrelated dirty'))
    const runner = baseRunner(root, {
      onGenerate: ({ root: fixtureRoot, service }) => {
        const path = `${service}/openapi.json`
        writeFileSync(join(fixtureRoot, path), ORIGINAL[path])
      },
    })
    const result = runVerifier(root, runner)
    assert.ok(result.commit)
    assertArtifactBytes(root)
    assert.equal(readFileSync(join(root, 'unrelated.txt')).toString(), 'unrelated dirty')
  } finally {
    cleanup(root)
  }
})

test('catches content drift hidden by assume-unchanged status', () => {
  const root = makeFixture()
  try {
    writeFileSync(join(root, ARTIFACTS[0]), Buffer.from('hidden drift'))
    command(root, ['update-index', '--assume-unchanged', '--', ARTIFACTS[0]])
    const status = command(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ARTIFACTS[0]]).stdout
    assert.equal(status, '')
    const runner = baseRunner(root)
    assert.throws(() => runVerifier(root, runner), /sha256 mismatch/)
    assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
    assertArtifactBytes(root, { ...ORIGINAL, [ARTIFACTS[0]]: Buffer.from('hidden drift') })
  } finally {
    cleanup(root)
  }
})

test('fails when a working-tree artifact is a symlink or directory before generation', () => {
  for (const replacement of ['symlink', 'directory']) {
    const root = makeFixture()
    try {
      const path = join(root, ARTIFACTS[1])
      unlinkSync(path)
      if (replacement === 'symlink') symlinkSync(ARTIFACTS[0], path)
      else mkdirSync(path)
      const runner = baseRunner(root)
      assert.throws(() => runVerifier(root, runner), /regular|symlink|directory|working-tree/i)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
      const other = ARTIFACTS.find((candidate) => candidate !== ARTIFACTS[1])
      assert.deepEqual(readFileSync(join(root, other)), ORIGINAL[other])
      if (replacement === 'symlink') assert.equal(lstatSync(path).isSymbolicLink(), true)
      else assert.equal(lstatSync(path).isDirectory(), true)
    } finally {
      cleanup(root)
    }
  }
})

test('reports generator status, stdout, and stderr without false success', () => {
  const root = makeFixture()
  try {
    const runner = baseRunner(root, { status: 7, stdout: 'generator output', stderr: 'generator error' })
    let error
    try {
      runVerifier(root, runner)
    } catch (caught) {
      error = caught
    }
    assert.ok(error)
    assert.match(error.message, /user-service contract generator failed/)
    assert.match(error.message, /user-service/)
    assert.match(error.message, /status=7/)
    assert.match(error.message, /generator output/)
    assert.match(error.message, /generator error/)
    assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 1)
    assert.deepEqual(readFileSync(join(root, ARTIFACTS[0])), ORIGINAL[ARTIFACTS[0]])
  } finally {
    cleanup(root)
  }
})

for (const behavior of ['different bytes', 'deleted output', 'untracked output']) {
  test(`rejects generator ${behavior} after generation`, () => {
    const root = makeFixture()
    try {
      const runner = baseRunner(root, {
        onGenerate: ({ root: fixtureRoot, service }) => {
          const path = `${service}/openapi.json`
          if (behavior === 'different bytes') writeFileSync(join(fixtureRoot, path), Buffer.from('different'))
          if (behavior === 'deleted output') unlinkSync(join(fixtureRoot, path))
          if (behavior === 'untracked output') {
            unlinkSync(join(fixtureRoot, path))
            writeFileSync(join(fixtureRoot, path), Buffer.from('untracked'))
            command(fixtureRoot, ['rm', '--cached', '-q', '--', path])
          }
        },
      })
      assert.throws(() => runVerifier(root, runner), /sha256 mismatch|regular|missing|tracked|status|dirty/i)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 2)
      if (behavior === 'different bytes') {
        assertArtifactBytes(root, { [ARTIFACTS[0]]: Buffer.from('different'), [ARTIFACTS[1]]: Buffer.from('different') })
      } else if (behavior === 'deleted output') {
        assert.equal(existsSync(join(root, ARTIFACTS[0])), false)
        assert.equal(existsSync(join(root, ARTIFACTS[1])), false)
      } else {
        assert.deepEqual(readFileSync(join(root, ARTIFACTS[0])), Buffer.from('untracked'))
        assert.deepEqual(readFileSync(join(root, ARTIFACTS[1])), Buffer.from('untracked'))
      }
    } finally {
      cleanup(root)
    }
  })
}

test('pins hash authority to the original HEAD when a generator stages changed bytes', () => {
  const root = makeFixture()
  try {
    const runner = baseRunner(root, {
      onGenerate: ({ root: fixtureRoot, service }) => {
        const path = `${service}/openapi.json`
        writeFileSync(join(fixtureRoot, path), Buffer.from('staged drift'))
        command(fixtureRoot, ['add', '--', path])
      },
    })
    assert.throws(() => runVerifier(root, runner), /sha256 mismatch/)
    assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 2)
  } finally {
    cleanup(root)
  }
})

for (const artifact of ARTIFACTS) {
  test(`staged deletion of ${artifact} fails while pinned HEAD still has the artifact`, () => {
    const root = makeFixture()
    try {
      command(root, ['rm', '--cached', '-q', '--', artifact])
      const runner = baseRunner(root)
      assert.throws(() => runVerifier(root, runner), /tracking|tracked|index/i)
      assert.equal(runner.calls.filter(({ commandName }) => commandName === 'npm').length, 0)
      assertArtifactBytes(root)
    } finally {
      cleanup(root)
    }
  })
}

test('rejects a generator that moves HEAD, even if it writes the original bytes', () => {
  const root = makeFixture()
  try {
    const runner = baseRunner(root, {
      onGenerate: ({ root: fixtureRoot, service }) => {
        writeFileSync(join(fixtureRoot, `${service}/openapi.json`), ORIGINAL[`${service}/openapi.json`])
        if (service === 'user-service') {
          writeFileSync(join(fixtureRoot, 'head-marker.txt'), Buffer.from('head changed'))
          command(fixtureRoot, ['add', '--', 'head-marker.txt'])
          command(fixtureRoot, ['commit', '-qm', 'generator moved HEAD'])
        }
      },
    })
    assert.throws(() => runVerifier(root, runner), /HEAD|pinned|commit/i)
  } finally {
    cleanup(root)
  }
})

test('workflow verification blocks run focused verifier tests and CLI while preserving Node22/install wiring', () => {
  const require = createRequire(resolve(BACKEND_ROOT, 'user-service/package.json'))
  const yaml = require('js-yaml')
  for (const workflow of ['.github/workflows/ci-main.yml', '.github/workflows/ci-feature.yml']) {
    const root = resolve(BACKEND_ROOT, workflow)
    const source = readFileSync(root, 'utf8')
    const parsed = yaml.load(source)
    const job = parsed.jobs['verify-openapi-contracts']
    assert.ok(job)
    const nodeStep = job.steps.find((step) => step.name === 'Use Node.js 22')
    assert.ok(nodeStep)
    assert.equal(String(nodeStep.with['node-version']), '22')
    const installStep = job.steps.find((step) => step.name === 'Install contract generator dependencies')
    assert.ok(installStep)
    assert.match(installStep.run, /npm --prefix user-service ci/)
    assert.match(installStep.run, /npm --prefix chat-service ci/)
    const verification = job.steps.find((step) => step.name === 'Verify committed OpenAPI contracts')
    assert.ok(verification)
    assert.match(verification.run, /node --test tests\/contract-artifacts\.test\.mjs tests\/contract-verifier\.test\.mjs/)
    assert.match(verification.run, /node scripts\/verify-contract-artifacts\.mjs/)
    assert.equal(job.needs, 'typescript-check')
    assert.equal(parsed.jobs['unit-tests'].needs, 'verify-openapi-contracts')
  }
})

test('verifier CLI executes through a symlink alias from an unrelated cwd', () => {
  const root = makeFixture()
  const unrelatedCwd = mkdtempSync(join(tmpdir(), 'contract-cli-cwd-'))
  try {
    for (const service of ['user-service', 'chat-service']) {
      mkdirSync(join(root, service), { recursive: true })
      writeFileSync(join(root, service, 'package.json'), JSON.stringify({
        private: true,
        scripts: { 'gen:spec': "node -e \"const fs=require('fs'); const p='openapi.json'; fs.writeFileSync(p, fs.readFileSync(p))\"" },
      }))
    }
    command(root, ['add', '--', 'user-service/package.json', 'chat-service/package.json'])
    command(root, ['commit', '-qm', 'fixture generator scripts'])
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const verifier = resolve(BACKEND_ROOT, 'scripts/verify-contract-artifacts.mjs')
    const copiedVerifier = join(root, 'scripts/verify-contract-artifacts.mjs')
    cpSync(verifier, copiedVerifier)
    const alias = join(root, 'scripts/verify-alias.mjs')
    symlinkSync(copiedVerifier, alias)
    const result = spawnSync(process.execPath, [alias], { cwd: unrelatedCwd, encoding: 'utf8', shell: false })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Verified pinned commit/)
  } finally {
    rmSync(unrelatedCwd, { recursive: true, force: true })
    cleanup(root)
  }
})
