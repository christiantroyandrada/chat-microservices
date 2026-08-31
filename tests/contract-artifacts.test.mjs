import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { replaceContractFile } from '../scripts/lib/atomic-contract-file.cjs'

const OLD_BYTES = Buffer.from('{"version":1}')
const NEW_BYTES = Buffer.from('{"version":2}')
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'contract-file-test-'))
  const target = join(directory, 'openapi.json')
  const sentinel = join(directory, 'foreign-sentinel.txt')
  writeFileSync(target, OLD_BYTES)
  writeFileSync(sentinel, Buffer.from('foreign'))
  return { directory, target, sentinel }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function injectedFilesystem(directory, target, { failStage } = {}) {
  const descriptors = new Map()
  const events = []
  let injected = false
  let collisionPath
  let movedStagePath

  const isStage = (fd) => descriptors.get(fd)?.flags === 'wx'
  const fs = {
    ...realFs,
    openSync(path, flags, mode) {
      const pathString = String(path)
      if (flags === 'wx' && !collisionPath && failStage === 'collision') {
        collisionPath = pathString
        realFs.writeFileSync(collisionPath, Buffer.from('foreign-collision'))
        injected = true
        throw fail('EEXIST', 'foreign collision')
      }
      const fd = realFs.openSync(path, flags, mode)
      descriptors.set(fd, { flags, path: pathString })
      events.push(['open', pathString, flags])
      return fd
    },
    writeSync(fd, ...args) {
      if (isStage(fd) && failStage === 'write' && !injected) {
        injected = true
        throw fail('EIO', 'staged write failed')
      }
      events.push(['write', descriptors.get(fd)?.path])
      return realFs.writeSync(fd, ...args)
    },
    fchmodSync(fd, mode) {
      const descriptor = descriptors.get(fd)
      if (descriptor?.flags === 'wx' && failStage === 'stage-chmod' && !injected) {
        injected = true
        throw fail('EIO', `staged chmod failed (${mode.toString(8)})`)
      }
      events.push(['chmod', descriptor?.path])
      return realFs.fchmodSync(fd, mode)
    },
    fstatSync(fd) {
      const descriptor = descriptors.get(fd)
      if (descriptor?.flags === 'wx' && failStage === 'fstat' && !injected) {
        injected = true
        realFs.unlinkSync(descriptor.path)
        realFs.writeFileSync(descriptor.path, Buffer.from('foreign-after-fstat'))
        throw fail('EIO', 'staged fstat failed')
      }
      return realFs.fstatSync(fd)
    },
    fsyncSync(fd) {
      const descriptor = descriptors.get(fd)
      if (descriptor?.flags === 'wx' && failStage === 'stage-fsync' && !injected) {
        injected = true
        throw fail('EIO', 'staged fsync failed')
      }
      if (descriptor?.path === directory && failStage === 'directory-fsync' && !injected) {
        injected = true
        throw fail('EIO', 'directory fsync failed')
      }
      events.push(['fsync', descriptor?.path])
      return realFs.fsyncSync(fd)
    },
    closeSync(fd) {
      const descriptor = descriptors.get(fd)
      if (descriptor?.flags === 'wx' && failStage === 'stage-close' && !injected) {
        injected = true
        events.push(['close', descriptor.path])
        realFs.closeSync(fd)
        descriptors.delete(fd)
        throw fail('EIO', 'staged close failed')
      }
      events.push(['close', descriptor?.path])
      const result = realFs.closeSync(fd)
      descriptors.delete(fd)
      if (descriptor?.flags === 'wx' && failStage === 'pre-rename-replacement' && !injected) {
        injected = true
        movedStagePath = `${descriptor.path}.moved`
        realFs.renameSync(descriptor.path, movedStagePath)
        realFs.writeFileSync(descriptor.path, Buffer.from('foreign-before-rename'))
      }
      return result
    },
    renameSync(source, destination) {
      if (String(source).startsWith(`${directory}/`) && failStage === 'rename' && !injected) {
        injected = true
        throw fail('EIO', 'rename failed')
      }
      events.push(['rename', String(source), String(destination)])
      return realFs.renameSync(source, destination)
    },
  }

  return {
    fs,
    events,
    getInjected: () => injected,
    getCollisionPath: () => collisionPath,
    getMovedStagePath: () => movedStagePath,
    getOpenDescriptors: () => [...descriptors.values()],
  }
}

test('replaceContractFile publishes complete bytes without truncating the target', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target)

  replaceContractFile(target, NEW_BYTES, { fs: injected.fs })

  assert.deepEqual(readFileSync(target), NEW_BYTES)
  const stageOpen = injected.events.findIndex(([operation, , flags]) => operation === 'open' && flags === 'wx')
  const stageWrite = injected.events.findIndex(([operation]) => operation === 'write')
  const stageFsync = injected.events.findIndex(([operation, path]) => operation === 'fsync' && path !== directory)
  const stageClose = injected.events.findIndex(([operation, path]) => operation === 'close' && path !== directory)
  const rename = injected.events.findIndex(([operation]) => operation === 'rename')
  assert.ok(stageOpen >= 0 && stageOpen < stageWrite)
  assert.ok(stageWrite < stageFsync && stageFsync < stageClose && stageClose < rename)
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

test('replaceContractFile preserves existing target permissions', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  chmodSync(target, 0o664)

  replaceContractFile(target, NEW_BYTES)

  assert.equal(statSync(target).mode & 0o777, 0o664)
  assert.deepEqual(readFileSync(target), NEW_BYTES)
})

test('replaceContractFile rejects invalid rendered bytes before writing', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => replaceContractFile(target, 42), /string or Buffer/)
  assert.deepEqual(readFileSync(target), OLD_BYTES)
})

test('serialization failure occurs before publication and preserves prior bytes', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const spec = { toJSON() { throw new Error('serialization failed') } }

  assert.throws(() => {
    const rendered = JSON.stringify(spec, null, 2)
    replaceContractFile(target, rendered)
  }, /serialization failed/)
  assert.deepEqual(readFileSync(target), OLD_BYTES)
  assert.equal(readdirSync(directory).filter((entry) => entry.startsWith('.contract-file-')).length, 0)
})

test('replaceContractFile rejects symlink and directory targets before writing', (t) => {
  for (const targetKind of ['symlink', 'directory']) {
    const { directory, target } = fixture()
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const sentinel = join(directory, 'target-sentinel')
    if (targetKind === 'symlink') {
      writeFileSync(sentinel, OLD_BYTES)
      unlinkSync(target)
      symlinkSync(sentinel, target)
    } else {
      unlinkSync(target)
      mkdirSync(target)
    }

    assert.throws(() => replaceContractFile(target, NEW_BYTES), /regular file/)
    if (targetKind === 'symlink') assert.deepEqual(readFileSync(sentinel), OLD_BYTES)
    assert.deepEqual(readFileSync(join(directory, 'foreign-sentinel.txt')), Buffer.from('foreign'))
  }
})

for (const failStage of ['write', 'stage-fsync', 'stage-close', 'rename']) {
  test(`replaceContractFile preserves prior bytes when ${failStage} fails`, (t) => {
    const { directory, target } = fixture()
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const injected = injectedFilesystem(directory, target, { failStage })

    assert.throws(
      () => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }),
      {
        write: /staged write/,
        'stage-fsync': /staged fsync/,
        'stage-close': /staged close/,
        rename: /rename failed/,
      }[failStage],
    )
    assert.equal(injected.getInjected(), true)
    assert.deepEqual(readFileSync(target), OLD_BYTES)
    assert.deepEqual(readFileSync(join(directory, 'foreign-sentinel.txt')), Buffer.from('foreign'))
    assert.equal(injected.events.filter(([operation]) => operation === 'rename').length, 0)
    assert.deepEqual(injected.getOpenDescriptors(), [])
    assert.equal(readdirSync(directory).filter((entry) => entry !== 'openapi.json' && entry !== 'foreign-sentinel.txt').length, 0)
  })
}

test('replaceContractFile never adopts pathname identity after fstat failure', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target, { failStage: 'fstat' })

  assert.throws(() => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }), /staged fstat/)
  assert.equal(injected.getInjected(), true)
  assert.deepEqual(readFileSync(target), OLD_BYTES)
  const foreign = readdirSync(directory).find((entry) => entry.startsWith('.contract-file-') && !entry.endsWith('.moved'))
  assert.ok(foreign)
  assert.deepEqual(readFileSync(join(directory, foreign)), Buffer.from('foreign-after-fstat'))
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

test('replaceContractFile cleans its owned temp after staged chmod failure', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target, { failStage: 'stage-chmod' })

  assert.throws(() => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }), /staged chmod/)
  assert.equal(injected.getInjected(), true)
  assert.deepEqual(readFileSync(target), OLD_BYTES)
  assert.deepEqual(readFileSync(join(directory, 'foreign-sentinel.txt')), Buffer.from('foreign'))
  assert.equal(readdirSync(directory).filter((entry) => entry.startsWith('.contract-file-')).length, 0)
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

test('replaceContractFile rejects a staged pathname replacement before rename', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target, { failStage: 'pre-rename-replacement' })

  assert.throws(() => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }), /ownership changed|temporary contract file/)
  assert.equal(injected.getInjected(), true)
  assert.deepEqual(readFileSync(target), OLD_BYTES)
  const foreign = readdirSync(directory).find((entry) => entry.startsWith('.contract-file-') && !entry.endsWith('.moved'))
  assert.ok(foreign)
  assert.deepEqual(readFileSync(join(directory, foreign)), Buffer.from('foreign-before-rename'))
  assert.deepEqual(readFileSync(injected.getMovedStagePath()), NEW_BYTES)
  assert.equal(injected.events.some(([operation]) => operation === 'rename'), false)
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

test('replaceContractFile never removes a foreign temp-file collision', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target, { failStage: 'collision' })

  assert.throws(() => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }), /foreign collision/)
  assert.equal(injected.getInjected(), true)
  assert.deepEqual(readFileSync(injected.getCollisionPath()), Buffer.from('foreign-collision'))
  assert.deepEqual(readFileSync(target), OLD_BYTES)
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

test('replaceContractFile reports post-rename directory fsync failure with new bytes retained', (t) => {
  const { directory, target } = fixture()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const injected = injectedFilesystem(directory, target, { failStage: 'directory-fsync' })

  assert.throws(
    () => replaceContractFile(target, NEW_BYTES, { fs: injected.fs }),
    /directory fsync/,
  )
  assert.equal(injected.getInjected(), true)
  assert.deepEqual(readFileSync(target), NEW_BYTES)
  assert.equal(injected.events.some(([operation]) => operation === 'rename'), true)
  assert.deepEqual(injected.getOpenDescriptors(), [])
})

function prepareActualExporter(service, fixtureRoot) {
  const source = resolve(BACKEND_ROOT, service)
  const destination = join(fixtureRoot, service)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(join(destination, 'src'), { recursive: true })
  mkdirSync(join(destination, 'scripts'), { recursive: true })
  for (const file of ['package.json', 'tsconfig.json', 'openapi.json']) {
    cpSync(join(source, file), join(destination, file))
  }
  cpSync(join(source, 'src/openapi.ts'), join(destination, 'src/openapi.ts'))
  cpSync(join(source, 'scripts/export-spec.ts'), join(destination, 'scripts/export-spec.ts'))
  symlinkSync(resolve(source, 'node_modules'), join(destination, 'node_modules'), 'dir')
  cpSync(resolve(BACKEND_ROOT, 'scripts/lib'), resolve(fixtureRoot, 'scripts/lib'), { recursive: true })
  writeFileSync(join(destination, 'openapi.json'), Buffer.from(`stale-${service}`))
}

function runActualExporter(service, fixtureRoot, unrelatedCwd) {
  const destination = join(fixtureRoot, service)
  return spawnSync('npm', ['--prefix', destination, 'run', 'gen:spec'], {
    cwd: unrelatedCwd,
    encoding: 'utf8',
    shell: false,
  })
}

test('both actual exporter entrypoints preserve exact deterministic bytes from an unrelated cwd', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'contract-exporter-fixture-'))
  const unrelatedCwd = mkdtempSync(join(tmpdir(), 'contract-exporter-cwd-'))
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(unrelatedCwd, { recursive: true, force: true })
  })

  for (const service of ['user-service', 'chat-service']) {
    const expected = readFileSync(resolve(BACKEND_ROOT, service, 'openapi.json'))
    prepareActualExporter(service, fixtureRoot)
    assert.notDeepEqual(readFileSync(join(fixtureRoot, service, 'openapi.json')), expected)
    const first = runActualExporter(service, fixtureRoot, unrelatedCwd)
    assert.equal(first.status, 0, `${service} exporter failed: ${first.stderr}`)
    const output = resolve(fixtureRoot, service, 'openapi.json')
    assert.deepEqual(readFileSync(output), expected)
    const firstBytes = readFileSync(output)
    const second = runActualExporter(service, fixtureRoot, unrelatedCwd)
    assert.equal(second.status, 0, `${service} exporter rerun failed: ${second.stderr}`)
    assert.deepEqual(readFileSync(output), firstBytes)
    assert.equal(first.stdout.includes('spec exported'), true)
  }
})
