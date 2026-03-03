/* stylelint-disable */
import util from 'node:util'

const IS_NON_PROD = process.env.NODE_ENV !== 'production'

const SERVICE_NAME = process.env.npm_package_name ?? 'notification-service'

/**
 * Safely serialize an unknown value to a JSON-compatible form.
 * Errors get { message, stack }; objects get deep-cloned via structuredClone;
 * primitives pass through unchanged.
 *
 * Fallback strategy when cloning an object:
 *   1. structuredClone available + succeeds  → return the clone
 *   2. structuredClone available but throws  → return original (uncloned) object
 *   3. structuredClone not available         → return bounded util.inspect() string
 */
function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) return { message: arg.message, stack: arg.stack }
  if (typeof arg === 'object' && arg !== null) {
    const sc = (globalThis as { structuredClone?: typeof structuredClone }).structuredClone
    if (typeof sc === 'function') {
      try { return sc(arg) } catch { /* fall through to return original below */ }
      return arg  // structuredClone threw — return original object unmodified
    }
    // structuredClone unavailable — bounded string representation (depth:3 avoids OOM on huge objects)
    return util.inspect(arg, { depth: 3 })
  }
  return arg
}

function buildJsonEntry(level: string, caller: string, args: unknown[]): string {
  const ts = new Date().toISOString()
  const base = { level, ts, service: SERVICE_NAME, caller }

  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !(args[0] instanceof Error)
  ) {
    try {
      return JSON.stringify({ ...base, ...(serializeArg(args[0]) as Record<string, unknown>) })
    } catch { /* fall through */ }
  }

  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(serializeArg(a))))
    .join(' ')
  try {
    return JSON.stringify({ ...base, msg })
  } catch {
    return JSON.stringify({ ...base, msg: String(args) })
  }
}

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
  return serializeArg(arg)
}

export function logDebug(...args: unknown[]) {
  if (!IS_NON_PROD) return
  const caller = getCallerContext()
  console.debug('[DEBUG]', caller, ...args.map(formatArg))
}

export function logInfo(...args: unknown[]) {
  const caller = getCallerContext()
  if (!IS_NON_PROD) {
    process.stdout.write(buildJsonEntry('info', caller, args) + '\n')
    return
  }
  console.log('[INFO]', caller, ...args.map(formatArg))
}

export function logWarn(...args: unknown[]) {
  const caller = getCallerContext()
  if (!IS_NON_PROD) {
    process.stderr.write(buildJsonEntry('warn', caller, args) + '\n')
    return
  }
  console.warn('[WARN]', caller, ...args.map(formatArg))
}

export function logError(...args: unknown[]) {
  const caller = getCallerContext()
  if (!IS_NON_PROD) {
    process.stderr.write(buildJsonEntry('error', caller, args) + '\n')
    return
  }
  console.error('[ERROR]', caller, ...args.map(formatArg))
}

export default {
  logDebug,
  logInfo,
  logWarn,
  logError,
}
