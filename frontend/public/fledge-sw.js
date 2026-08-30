const CACHE = 'fledge-shell-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith('fledge-shell-') && key !== CACHE).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE)
          await cache.put('/', response.clone())
        }
        return response
      } catch {
        return caches.match('/')
      }
    })())
    return
  }

  if (/\/assets\/|\/fledge-icon-|\/fledge-manifest\.json$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) {
        const cache = await caches.open(CACHE)
        await cache.put(request, response.clone())
      }
      return response
    })())
  }
})

self.addEventListener('push', event => {
  let payload = {}
  try { payload = event.data?.json() || {} } catch { payload = { body: event.data?.text() || '' } }
  event.waitUntil(self.registration.showNotification(payload.title || 'Fledge', {
    body: payload.body || 'A new dispatch is ready.',
    tag: payload.tag || 'fledge-dispatch',
    icon: '/fledge-icon-192.png',
    badge: '/fledge-icon-192.png',
    data: { url: payload.url || '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const supplied = event.notification.data?.url || '/'
  const target = new URL(supplied, self.location.origin)
  const sessionId = target.searchParams.get('session')
  const targetUrl = sessionId ? `${self.location.origin}/#${encodeURIComponent(sessionId)}` : target.href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin)
    if (existing) {
      await existing.navigate(targetUrl)
      return existing.focus()
    }
    return self.clients.openWindow(targetUrl)
  })())
})
