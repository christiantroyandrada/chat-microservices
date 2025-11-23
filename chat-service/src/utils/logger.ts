import util from 'node:util'

const IS_NON_PROD = process.env.NODE_ENV !== 'production'

function getCallerContext(): string {
  try {
    const err = new Error('getCallerContext stack')
    const stack = err.stack || ''
    const lines = stack.split('\n')
    const re1 = /\((.*):(\d+):(\d+)\)/
    const re2 = /at\s+(.*):(\d+):(\d+)/
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i] || ''
      if (line.includes('logger') || line.includes('node_modules')) continue
      // Use RegExp.exec for slightly clearer intention and to avoid creating
      // temporary arrays via String.prototype.match every iteration.
      const m = re1.exec(line) || re2.exec(line)
      if (m) {
        const filePath = m[1]
        const lineNum = m[2]
        const file = filePath.split('/').pop() || filePath
        return `${file}:${lineNum}`
      }
    }
    return ''
  } catch {
    return ''
  }
}

function formatArg(arg: unknown): unknown {
  if (arg instanceof Error) return { message: arg.message, stack: arg.stack }
  if (typeof arg === 'object' && arg !== null) {
    try {
      // Prefer structuredClone when available (native deep clone). Some
      // runtimes may not implement it or it may throw for certain inputs
      const sc = (globalThis).structuredClone
      if (typeof sc === 'function') {
        try {
          return sc(arg)
        } catch {
          // structuredClone failed for this value; fall through
        }
      }

      // Fallback: shallow/serializable deep clone via JSON
      try {
        return JSON.parse(JSON.stringify(arg))
      } catch {
        // Fall back to util.inspect below
      }
    } catch {
      // Fall back to util.inspect so objects are displayed readably
      return util.inspect(arg, { depth: null })
    }
  }
  return arg
}

export function logDebug(...args: unknown[]) {
  if (!IS_NON_PROD) return
  const caller = getCallerContext()
  console.debug('[DEBUG]', caller, ...args.map(formatArg))
}

export function logInfo(...args: unknown[]) {
  if (!IS_NON_PROD) return
  const caller = getCallerContext()
  console.log('[INFO]', caller, ...args.map(formatArg))
}

export function logWarn(...args: unknown[]) {
  if (!IS_NON_PROD) return
  const caller = getCallerContext()
  console.warn('[WARN]', caller, ...args.map(formatArg))
}

export function logError(...args: unknown[]) {
  if (!IS_NON_PROD) return
  const caller = getCallerContext()
  console.error('[ERROR]', caller, ...args.map(formatArg))
}

export default {
  logDebug,
  logInfo,
  logWarn,
  logError,
}
