/* stylelint-disable */
import util from 'node:util'

const IS_NON_PROD = process.env.NODE_ENV !== 'production'

function getCallerContext(): string {
  try {
    const err = new Error('getCallerContext stack')
    const stack = err.stack || ''
    const lines = stack.split('\n')
    // Avoid vulnerable/ambiguous greedy regular expressions which can
    // suffer from catastrophic backtracking on malicious input. Instead
    // of relying on (.*) style patterns, parse stack lines from the end
    // to reliably extract file path, line and column numbers.
    function parseFileLineColFromParen(line: string): RegExpExecArray | null {
      const start = line.indexOf('(')
      const end = line.lastIndexOf(')')
      if (start === -1 || end === -1 || end <= start + 1) return null
      const inner = line.slice(start + 1, end)
      return parsePathLineCol(inner)
    }

    function parseFileLineColFromAt(line: string): RegExpExecArray | null {
      const atIndex = line.indexOf('at ')
      if (atIndex === -1) return null
      const afterAt = line.slice(atIndex + 3).trim()
      return parsePathLineCol(afterAt)
    }

    // Parse a string of the form: <path>:<line>:<col>
    // We intentionally avoid complex regexes and instead locate the last
    // two ':' characters and validate the numeric groups. Returns an
    // array shaped like RegExp.exec results: [full, file, line, col]
    function parsePathLineCol(s: string): RegExpExecArray | null {
      const lastColon = s.lastIndexOf(':')
      if (lastColon === -1) return null
      const secondLastColon = s.lastIndexOf(':', lastColon - 1)
      if (secondLastColon === -1) return null

      const filePath = s.slice(0, secondLastColon)
      const lineNum = s.slice(secondLastColon + 1, lastColon)
      const colNum = s.slice(lastColon + 1)

      if (!/^\d+$/.test(lineNum) || !/^\d+$/.test(colNum)) return null

      // Construct an array compatible with RegExp.exec usage in the
      // original code (index 1 = filePath, 2 = line, 3 = col).
      const res: any = []
      res[0] = s
      res[1] = filePath
      res[2] = lineNum
      res[3] = colNum
      return res as RegExpExecArray
    }
    for (let i = 2; i < lines.length; i++) {
  const line = lines[i] || ''
  if (line.includes('logger') || line.includes('node_modules')) continue

  // Try safe parseers instead of running potentially expensive regexes
  // with ambiguous wildcards.
  const m = parseFileLineColFromParen(line) || parseFileLineColFromAt(line)
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
  if (!IS_NON_PROD) {
    console.log('[INFO]', ...args.map(formatArg))
    return
  }
  const caller = getCallerContext()
  console.log('[INFO]', caller, ...args.map(formatArg))
}

export function logWarn(...args: unknown[]) {
  if (!IS_NON_PROD) {
    console.warn('[WARN]', ...args.map(formatArg))
    return
  }
  const caller = getCallerContext()
  console.warn('[WARN]', caller, ...args.map(formatArg))
}

export function logError(...args: unknown[]) {
  if (!IS_NON_PROD) {
    console.error('[ERROR]', ...args.map(formatArg))
    return
  }
  const caller = getCallerContext()
  console.error('[ERROR]', caller, ...args.map(formatArg))
}

export default {
  logDebug,
  logInfo,
  logWarn,
  logError,
}
