function currentLocation() {
  return typeof location === 'undefined'
    ? { protocol: 'http:', host: 'localhost', pathname: '/' }
    : location
}

export function appBasePath(pathname = currentLocation().pathname) {
  return pathname.replace(/\/+$/, '')
}

export function appUrl(route, pathname = currentLocation().pathname) {
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`
  return `${appBasePath(pathname)}${normalizedRoute}`
}

export function appWebSocketUrl(route, appLocation = currentLocation()) {
  const protocol = appLocation.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${appLocation.host}${appUrl(route, appLocation.pathname)}`
}
