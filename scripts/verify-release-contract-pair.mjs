import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const backendPaths = ['chat-service/openapi.json', 'user-service/openapi.json']
const copiedPaths = ['contracts/chat-service.openapi.json', 'contracts/user-service.openapi.json']
const sourcePath = 'contracts/source.json'
const manifestPath = 'contracts/contract-snapshot.manifest.json'
const frontendPaths = [...copiedPaths, sourcePath, 'src/lib/generated/api.operations.ts', 'src/lib/generated/api.types.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const usage = 'Usage: node scripts/verify-release-contract-pair.mjs --backend-dir <path> --frontend-dir <path>'

function git(run, root, args, encoding = 'utf8') {
  try {
    return run('git', args, { cwd: root, encoding, stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`Git ${args[0]} failed in ${root}: ${error.message}`, { cause: error })
  }
}

function repository(run, dir, label) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${label} is required`)
  const root = realpathSync(resolve(dir))
  if (realpathSync(git(run, root, ['rev-parse', '--show-toplevel']).trim()) !== root) {
    throw new Error(`${label} must be a Git repository root`)
  }
  return root
}

function head(run, root, expected) {
  const commit = git(run, root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid exact HEAD commit in ${root}`)
  if (expected && commit !== expected) throw new Error(`HEAD moved in ${root}: ${expected} -> ${commit}`)
  return commit
}

function snapshot(run, root, commit, paths) {
  head(run, root, commit)
  const bytes = {}
  for (const path of paths) {
    let current = root
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      let stat
      try { stat = lstatSync(current) } catch (error) {
        throw new Error(`Required artifact ${path} is missing in ${root}`, { cause: error })
      }
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`Required artifact ${path} must use regular files and directories in ${root}`)
      }
    }
    if (git(run, root, ['ls-files', '--', path]).trim() !== path) {
      throw new Error(`Required artifact ${path} is not tracked in ${root}`)
    }
    const entry = git(run, root, ['ls-tree', commit, '--', path])
    if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) || entry.trim().split('\t')[1] !== path) {
      throw new Error(`Required artifact ${path} is not a tracked regular committed file in ${root}`)
    }
    bytes[path] = git(run, root, ['show', `${commit}:${path}`], null)
    if (!readFileSync(current).equals(bytes[path])) {
      throw new Error(`Required artifact ${path} differs from committed bytes in ${root}`)
    }
  }
  const status = git(run, root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths])
  if (status !== '') throw new Error(`Required artifacts are dirty in ${root}:\n${status}`)
  head(run, root, commit)
  return bytes
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} must contain exactly these keys: ${keys.join(', ')}`)
  }
}

function hashes(value, paths, label) {
  exactKeys(value, paths, label)
  for (const path of paths) {
    if (typeof value[path] !== 'string' || !/^[a-f0-9]{64}$/.test(value[path])) {
      throw new Error(`${label}.${path} must be a lowercase SHA-256 hash`)
    }
  }
}

function metadata(value, label, commit) {
  if (value.backendCommit !== commit) throw new Error(`${label}.backendCommit must equal backend HEAD ${commit}`)
  if (value.generatorVersion !== 1) throw new Error(`${label}.generatorVersion must be 1`)
  hashes(value.backendSources, backendPaths, `${label}.backendSources`)
}

function json(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`, { cause: error })
  }
}

export function verifyReleaseContractPair({ backendDir, frontendDir, run = execFileSync } = {}) {
  const backend = repository(run, backendDir, 'backendDir')
  const frontend = repository(run, frontendDir, 'frontendDir')
  const backendCommit = head(run, backend)
  const frontendCommit = head(run, frontend)
  const backendBytes = snapshot(run, backend, backendCommit, backendPaths)
  const frontendBytes = snapshot(run, frontend, frontendCommit, [...frontendPaths, manifestPath])
  const source = json(frontendBytes[sourcePath], sourcePath)
  const manifest = json(frontendBytes[manifestPath], manifestPath)
  exactKeys(source, ['backendCommit', 'generatorVersion', 'backendSources'], sourcePath)
  exactKeys(manifest, ['schemaVersion', 'backendCommit', 'generatorVersion', 'backendSources', 'frontendArtifacts'], manifestPath)
  metadata(source, sourcePath, backendCommit)
  metadata(manifest, manifestPath, backendCommit)
  if (manifest.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')
  if (!isDeepStrictEqual(source.backendSources, manifest.backendSources)) {
    throw new Error('source and manifest backendSources must agree')
  }
  hashes(manifest.frontendArtifacts, frontendPaths, 'manifest.frontendArtifacts')
  for (const path of frontendPaths) {
    if (hash(frontendBytes[path]) !== manifest.frontendArtifacts[path]) {
      throw new Error(`manifest.frontendArtifacts.${path} hash differs from committed bytes`)
    }
  }
  for (const [index, path] of backendPaths.entries()) {
    if (hash(backendBytes[path]) !== source.backendSources[path]) {
      throw new Error(`source.backendSources.${path} hash differs from current backend bytes`)
    }
    if (!isDeepStrictEqual(json(backendBytes[path], path), json(frontendBytes[copiedPaths[index]], copiedPaths[index]))) {
      throw new Error(`Frontend copied contract ${copiedPaths[index]} differs from backend ${path}`)
    }
  }
  snapshot(run, backend, backendCommit, backendPaths)
  snapshot(run, frontend, frontendCommit, [...frontendPaths, manifestPath])
  head(run, backend, backendCommit)
  head(run, frontend, frontendCommit)
  return { backendCommit, frontendCommit }
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || !['--backend-dir', '--frontend-dir'].includes(args[0]) ||
      !['--backend-dir', '--frontend-dir'].includes(args[2]) || args[0] === args[2] ||
      !args[1]?.trim() || !args[3]?.trim() || args[1].startsWith('--') || args[3].startsWith('--')) {
      throw new Error(usage)
    }
    const dirs = Object.fromEntries([[args[0], args[1]], [args[2], args[3]]])
    const result = verifyReleaseContractPair({ backendDir: dirs['--backend-dir'], frontendDir: dirs['--frontend-dir'] })
    console.log(`Verified release contract pair backend ${result.backendCommit} frontend ${result.frontendCommit}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
