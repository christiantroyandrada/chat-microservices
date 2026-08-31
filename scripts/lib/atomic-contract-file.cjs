'use strict'

const { randomUUID } = require('node:crypto')
const defaultFs = require('node:fs')
const { dirname, isAbsolute, join } = require('node:path')

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
}

function combineErrors(primary, secondary, message) {
  if (!primary) return secondary
  if (!secondary) return primary
  return new AggregateError([primary, secondary], `${message}: ${primary.message}; ${secondary.message}`)
}

function removeOwnedTemporaryFile(filesystem, temporaryPath, identity) {
  if (!identity) {
    return new Error(`Cannot verify ownership of temporary contract file ${temporaryPath}`)
  }

  let current
  try {
    current = filesystem.lstatSync(temporaryPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return error
  }

  if (!sameFileIdentity(current, identity)) {
    return new Error(`Refusing to remove temporary contract file ${temporaryPath}: ownership changed`)
  }

  try {
    filesystem.unlinkSync(temporaryPath)
    return undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return error
  }
}

function flushContainingDirectory(filesystem, directory) {
  let directoryFd
  let failure

  try {
    directoryFd = filesystem.openSync(directory, 'r')
    filesystem.fsyncSync(directoryFd)
  } catch (error) {
    failure = error
  }

  if (directoryFd !== undefined) {
    try {
      filesystem.closeSync(directoryFd)
    } catch (error) {
      failure = combineErrors(failure, error, `Unable to close directory descriptor for ${directory}`)
    }
  }

  if (failure) throw failure
}

function replaceContractFile(targetPath, renderedBytes, { fs: filesystem = defaultFs } = {}) {
  if (typeof targetPath !== 'string' || !targetPath || !isAbsolute(targetPath)) {
    throw new TypeError('targetPath must be a non-empty absolute path')
  }
  if (typeof renderedBytes !== 'string' && !Buffer.isBuffer(renderedBytes)) {
    throw new TypeError('renderedBytes must be a string or Buffer')
  }

  const bytes = Buffer.from(renderedBytes)
  const directory = dirname(targetPath)
  let existing

  try {
    existing = filesystem.lstatSync(targetPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Contract target must be a regular file: ${targetPath}`)
  }

  const temporaryPath = join(directory, `.contract-file-${process.pid}-${randomUUID()}.tmp`)
  const mode = existing ? existing.mode & 0o7777 : 0o644
  let descriptor
  let identity
  let failure

  try {
    descriptor = filesystem.openSync(temporaryPath, 'wx', mode)
    identity = filesystem.fstatSync(descriptor)
    filesystem.fchmodSync(descriptor, mode)

    let offset = 0
    while (offset < bytes.length) {
      const written = filesystem.writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error(`Unable to write staged contract file ${temporaryPath}`)
      }
      offset += written
    }
    filesystem.fsyncSync(descriptor)
  } catch (error) {
    failure = error
  }

  if (descriptor !== undefined) {
    try {
      filesystem.closeSync(descriptor)
    } catch (error) {
      failure = combineErrors(failure, error, `Unable to close staged contract file ${temporaryPath}`)
    }
  }

  if (failure) {
    const cleanupFailure = removeOwnedTemporaryFile(filesystem, temporaryPath, identity)
    throw combineErrors(failure, cleanupFailure, `Contract publication failed for ${targetPath}`)
  }

  let stagedIdentity
  try {
    stagedIdentity = filesystem.lstatSync(temporaryPath)
  } catch (error) {
    const cleanupFailure = removeOwnedTemporaryFile(filesystem, temporaryPath, identity)
    throw combineErrors(error, cleanupFailure, `Contract publication failed for ${targetPath}`)
  }
  if (!sameFileIdentity(stagedIdentity, identity)) {
    const ownershipFailure = new Error(`Refusing to rename temporary contract file ${temporaryPath}: ownership changed`)
    const cleanupFailure = removeOwnedTemporaryFile(filesystem, temporaryPath, identity)
    throw combineErrors(ownershipFailure, cleanupFailure, `Contract publication failed for ${targetPath}`)
  }

  try {
    filesystem.renameSync(temporaryPath, targetPath)
  } catch (error) {
    const cleanupFailure = removeOwnedTemporaryFile(filesystem, temporaryPath, identity)
    throw combineErrors(error, cleanupFailure, `Contract publication failed for ${targetPath}`)
  }

  try {
    flushContainingDirectory(filesystem, directory)
  } catch (error) {
    throw new Error(
      `Contract ${targetPath} was published, but containing directory durability failed: ${error.message}`,
      { cause: error },
    )
  }
}

module.exports = { replaceContractFile }
