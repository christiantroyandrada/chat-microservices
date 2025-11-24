import fs from 'fs'
import path from 'path'
import { logError } from '../utils/logger'

/**
 * Load an HTML template from disk. Tries multiple candidate locations so
 * the function works both from the source tree and from the built image.
 */
export function loadTemplate (name: string): string {
  try {
    const candidates = [
      path.join(__dirname, '..', 'templates', name), // build/src/templates
      path.join(__dirname, '..', '..', 'src', 'templates', name), // src/templates when running from repo
      path.join(process.cwd(), 'src', 'templates', name), // fallback to working dir
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8')
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

/**
 * Load a logo (PNG preferred) and return a data URI. Supports pre-encoded
 * .b64 files as well as raw PNG files; falls back to a small SVG data URI.
 */
export function loadLogoDataUri (): string {
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
          return `data:image/png;base64,${b64}`
        }

        const bin = fs.readFileSync(p)
        return `data:image/png;base64,${bin.toString('base64')}`
      }
    }

    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z' fill='%23ffffff'/></svg>`
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  } catch (e) {
    logError('[notification-service] failed to load logo data uri', e)
    return ''
  }
}

/**
 * Load the raw logo as a base64 attachment suitable for SMTP/Brevo.
 * Returns an object with filename, contentBase64 and a stable cid.
 */
export function loadLogoAttachment (): { filename: string; contentBase64: string; cid: string } | null {
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
          return { filename: 'logo.png', contentBase64: b64, cid: 'logo@chat-app' }
        }

        const bin = fs.readFileSync(p)
        return { filename: 'logo.png', contentBase64: bin.toString('base64'), cid: 'logo@chat-app' }
      }
    }

    return null
  } catch (e) {
    logError('[notification-service] failed to load logo attachment', e)
    return null
  }
}
