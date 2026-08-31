import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const CONTRACT_ENTRIES = Object.freeze([
  Object.freeze({ service: 'user-service', artifact: 'user-service/openapi.json' }),
  Object.freeze({ service: 'chat-service', artifact: 'chat-service/openapi.json' }),
])
export const CONTRACT_ARTIFACTS = Object.freeze(CONTRACT_ENTRIES.map(({ artifact }) => artifact))

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..')

function text(value) {
  if (value === undefined || value === null) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function commandFailure(label, result) {
  const detail = [
    `${label} failed`,
    `status=${result?.status ?? 'unknown'}`,
    result?.signal ? `signal=${result.signal}` : '',
    result?.error ? `error=${result.error.message ?? result.error}` : '',
    text(result?.stdout) ? `stdout:\n${text(result.stdout)}` : 'stdout: <empty>',
    text(result?.stderr) ? `stderr:\n${text(result.stderr)}` : 'stderr: <empty>',
  ].filter(Boolean).join('\n')
  return new Error(detail)
}

function runCommand(run, command, args, options, label) {
  let result
  try {
    result = run(command, args, options)
  } catch (error) {
    throw new Error(`${label} failed to spawn: ${error.message}`, { cause: error })
  }
  if (!result || result.error || result.signal || result.status !== 0) {
    throw commandFailure(label, result)
  }
  return result
}

function git(run, repositoryRoot, args, label, encoding = 'utf8') {
  return runCommand(
    run,
    'git',
    args,
    { cwd: repositoryRoot, encoding, shell: false },
    label,
  )
}

function assertRegularFile(repositoryRoot, artifact) {
  const path = resolve(repositoryRoot, artifact)
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new Error(`working-tree artifact ${artifact} is missing: ${error.message}`, { cause: error })
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`working-tree artifact ${artifact} is not a regular file`)
  }
  return path
}

function assertTracked(run, repositoryRoot, artifact, phase) {
  const result = git(run, repositoryRoot, ['ls-files', '--error-unmatch', '--', artifact], `${phase} tracking check for ${artifact}`)
  const tracked = text(result.stdout).split(/\r?\n/).filter(Boolean)
  if (!tracked.includes(artifact)) {
    throw new Error(`${phase} tracking check for ${artifact} returned an unexpected path`)
  }
}

function assertClean(run, repositoryRoot, phase) {
  const result = git(
    run,
    repositoryRoot,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...CONTRACT_ARTIFACTS],
    `${phase} path-scoped status check`,
  )
  const status = text(result.stdout)
  if (status !== '') {
    throw new Error(`${phase} contract artifacts are dirty:\n${status}`)
  }
}

function pinnedHead(run, repositoryRoot, expected, phase) {
  const result = git(run, repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], `${phase} HEAD check`)
  const commit = text(result.stdout).trim()
  if (!commit || /\s/.test(commit)) throw new Error(`${phase} HEAD is not a single commit: ${commit}`)
  if (expected && commit !== expected) {
    throw new Error(`${phase} HEAD moved from pinned commit ${expected} to ${commit}`)
  }
  return commit
}

function snapshotPreflight(run, repositoryRoot) {
  const commit = pinnedHead(run, repositoryRoot, undefined, 'preflight')
  const bytes = {}
  const hashes = {}
  for (const artifact of CONTRACT_ARTIFACTS) {
    const path = assertRegularFile(repositoryRoot, artifact)
    assertTracked(run, repositoryRoot, artifact, 'preflight')
    const blob = git(run, repositoryRoot, ['show', `${commit}:${artifact}`], `preflight pinned blob lookup for ${artifact}`, null)
    const expected = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout ?? '')
    const actual = readFileSync(path)
    bytes[artifact] = expected
    hashes[artifact] = createHash('sha256').update(expected).digest('hex')
    if (!actual.equals(expected)) {
      throw new Error(`preflight artifact ${artifact} differs from pinned HEAD blob (sha256 mismatch)`)
    }
  }
  assertClean(run, repositoryRoot, 'preflight')
  return { commit, bytes, hashes }
}

function postflight(run, repositoryRoot, snapshot) {
  pinnedHead(run, repositoryRoot, snapshot.commit, 'postflight')
  for (const artifact of CONTRACT_ARTIFACTS) {
    const path = assertRegularFile(repositoryRoot, artifact)
    assertTracked(run, repositoryRoot, artifact, 'postflight')
    const actual = readFileSync(path)
    const actualHash = createHash('sha256').update(actual).digest('hex')
    if (actualHash !== snapshot.hashes[artifact] || !actual.equals(snapshot.bytes[artifact])) {
      throw new Error(`postflight artifact ${artifact} differs from its pinned HEAD blob (sha256 mismatch)`)
    }
  }
  assertClean(run, repositoryRoot, 'postflight')
}

function generator(run, repositoryRoot, service) {
  const result = runCommand(
    run,
    'npm',
    ['--prefix', service, 'run', 'gen:spec'],
    { cwd: repositoryRoot, encoding: 'utf8', shell: false },
    `${service} contract generator`,
  )
  return result
}

export function verifyContractArtifacts({ repositoryRoot = DEFAULT_REPOSITORY_ROOT, run = spawnSync } = {}) {
  const root = resolve(repositoryRoot)
  const snapshot = snapshotPreflight(run, root)
  for (const { service } of CONTRACT_ENTRIES) generator(run, root, service)
  postflight(run, root, snapshot)
  return { commit: snapshot.commit, hashes: { ...snapshot.hashes } }
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : ''
if (invokedPath && pathToFileURL(invokedPath).href === pathToFileURL(SCRIPT_PATH).href) {
  try {
    const result = verifyContractArtifacts()
    console.log(`Verified pinned commit ${result.commit}`)
    for (const artifact of CONTRACT_ARTIFACTS) console.log(`${artifact} sha256 ${result.hashes[artifact]}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
