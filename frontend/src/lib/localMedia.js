// Recognize local filesystem references embedded in Markdown. Browsers treat
// absolute paths as site URLs, so callers can route them through Feather's
// authenticated, allow-listed raw-file endpoint instead.

const WEB_SCHEME_RE = /^(https?:|data:|blob:|mailto:)/i
const APP_ROUTES = ['/api/', '/uploads/', '/assets/', '/static/', '/vnc']

// Return the filesystem path a src/href refers to, or null if it is not a
// local file reference. Accepts /abs/path, ~/path, and file:// URLs.
export function localFilePath(src) {
  if (!src || typeof src !== 'string') return null
  if (WEB_SCHEME_RE.test(src)) return null
  if (APP_ROUTES.some(route => src.startsWith(route))) return null
  const raw = src.startsWith('file://') ? src.slice(7) : src
  if (!raw.startsWith('/') && !raw.startsWith('~/') && raw !== '~') return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

// Canonical unprefixed URL used by tests and direct deployments. The chat UI
// adds any current pathname prefix before using this route.
export function localFileUrl(src) {
  const filePath = localFilePath(src)
  return filePath ? `/api/files/raw?path=${encodeURIComponent(filePath)}` : null
}
