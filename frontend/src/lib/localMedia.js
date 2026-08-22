// Recognize local filesystem references embedded in Markdown. Browsers treat
// absolute paths as site URLs, so callers can route them through Feather's
// authenticated, allow-listed raw-file endpoint instead.

import { appUrl } from './appPath.js'

const WEB_SCHEME_RE = /^(https?:|data:|blob:|mailto:)/i
const APP_ROUTES = ['/api/', '/uploads/', '/assets/', '/static/', '/vnc']

// Return the filesystem path a src/href refers to, or null if it is not a
// local file reference. Accepts /abs/path, ~/path, and file:// URLs.
export function localFilePath(src, pathname) {
  if (!src || typeof src !== 'string') return null
  if (WEB_SCHEME_RE.test(src)) return null
  if (APP_ROUTES.some(route => src.startsWith(route) || src.startsWith(appUrl(route, pathname)))) return null
  const raw = src.startsWith('file://') ? src.slice(7) : src
  if (!raw.startsWith('/') && !raw.startsWith('~/') && raw !== '~') return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

export function localFileUrl(src, pathname) {
  const filePath = localFilePath(src, pathname)
  return filePath ? appUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`, pathname) : null
}
