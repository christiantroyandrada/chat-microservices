const IS_NON_PROD = process.env.NODE_ENV !== 'production'

function getCallerContext(): string {
  try {
    const err = new Error()
    const stack = err.stack || ''
    const lines = stack.split('\n')
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i] || ''
      if (line.includes('logger') || line.includes('node_modules')) continue
      const m = line.match(/\((.*):([0-9]+):([0-9]+)\)/) || line.match(/at\s+(.*):([0-9]+):([0-9]+)/)
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
      return JSON.parse(JSON.stringify(arg))
    } catch {
      return String(arg)
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
