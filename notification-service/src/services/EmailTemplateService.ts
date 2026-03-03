import fs from 'fs'
import path from 'path'
import { logError, logInfo } from '../utils/logger'

// ── In-memory template cache ────────────────────────────────────────
// Templates are static files that never change at runtime. Reading them
// from disk on every notification is unnecessary sync I/O that blocks the
// event loop. We cache on first read so subsequent calls are O(1) lookups.
const templateCache = new Map<string, string>()

/**
 * Load an HTML template from disk (cached after first read).
 * Tries multiple candidate locations so the function works both from the
 * source tree and from the built image.
 */
export function loadTemplate (name: string): string {
  const cached = templateCache.get(name)
  if (cached !== undefined) return cached

  try {
    const candidates = [
      path.join(__dirname, '..', 'templates', name), // build/src/templates
      path.join(__dirname, '..', '..', 'src', 'templates', name), // src/templates when running from repo
      path.join(process.cwd(), 'src', 'templates', name), // fallback to working dir
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8')
        templateCache.set(name, content)
        logInfo(`[notification-service] cached template: ${name}`)
        return content
      }
    }

    throw new Error(`template ${name} not found in candidates: ${candidates.join(',')}`)
  } catch (e) {
    logError(`[notification-service] failed to load template ${name}`, e)
    return ''
  }
}

/**
 * Simple placeholder-style renderer for templates using {{KEY}} placeholders.
 */
export function renderTemplate (tpl: string, vars: Record<string, string>): string {
  if (!tpl) return ''
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    return vars[key] ?? ''
  })
}

// ── In-memory logo caches ───────────────────────────────────────────
let cachedLogoDataUri: string | null = null
let cachedLogoAttachment: { filename: string; contentBase64: string; cid: string } | null | undefined

/**
 * Clear all in-memory caches. Exposed for testing so tests can reset
 * state between runs without module re-imports.
 */
export function clearTemplateCaches (): void {
  templateCache.clear()
  cachedLogoDataUri = null
  cachedLogoAttachment = undefined
}

/**
 * Load a logo (PNG preferred) and return a data URI. Supports pre-encoded
 * .b64 files as well as raw PNG files; falls back to a small SVG data URI.
 * Cached after first call — the logo never changes at runtime.
 */
export function loadLogoDataUri (): string {
  if (cachedLogoDataUri !== null) return cachedLogoDataUri
  try {
    const candidates = [
      path.join(__dirname, '..', 'templates', 'logo.png.b64'),
      path.join(__dirname, '..', 'templates', 'logo.png'),
      path.join(__dirname, '..', '..', 'src', 'templates', 'logo.png'),
      path.join(process.cwd(), 'src', 'templates', 'logo.png'),
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        if (p.endsWith('.b64')) {
          const b64 = fs.readFileSync(p, 'utf8').trim()
          cachedLogoDataUri = `data:image/png;base64,${b64}`
          return cachedLogoDataUri
        }

        const bin = fs.readFileSync(p)
        cachedLogoDataUri = `data:image/png;base64,${bin.toString('base64')}`
        return cachedLogoDataUri
      }
    }

    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z' fill='%23ffffff'/></svg>`
    cachedLogoDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    return cachedLogoDataUri
  } catch (e) {
    logError('[notification-service] failed to load logo data uri', e)
    cachedLogoDataUri = ''
    return ''
  }
}

/**
 * Load the raw logo as a base64 attachment suitable for SMTP/Brevo.
 * Returns an object with filename, contentBase64 and a stable cid.
 * Cached after first call — the logo never changes at runtime.
 */
export function loadLogoAttachment (): { filename: string; contentBase64: string; cid: string } | null {
  if (cachedLogoAttachment !== undefined) return cachedLogoAttachment
  try {
    const candidates = [
      path.join(__dirname, '..', 'templates', 'logo.png.b64'),
      path.join(__dirname, '..', 'templates', 'logo.png'),
      path.join(__dirname, '..', '..', 'src', 'templates', 'logo.png'),
      path.join(process.cwd(), 'src', 'templates', 'logo.png'),
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        if (p.endsWith('.b64')) {
          let b64 = fs.readFileSync(p, 'utf8').trim()
          // strip possible data URI prefix
          b64 = b64.replace(/^data:image\/[a-zA-Z]+;base64,/, '')
          cachedLogoAttachment = { filename: 'logo.png', contentBase64: b64, cid: 'logo@chat-app' }
          return cachedLogoAttachment
        }

        const bin = fs.readFileSync(p)
        cachedLogoAttachment = { filename: 'logo.png', contentBase64: bin.toString('base64'), cid: 'logo@chat-app' }
        return cachedLogoAttachment
      }
    }

    cachedLogoAttachment = null
    return null
  } catch (e) {
    logError('[notification-service] failed to load logo attachment', e)
    cachedLogoAttachment = null
    return null
  }
}
