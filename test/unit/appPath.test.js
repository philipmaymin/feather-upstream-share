import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { appBasePath, appUrl, appWebSocketUrl } from '../../frontend/src/lib/appPath.js'

describe('mounted application paths', () => {
  it('keeps root deployments at root', () => {
    assert.equal(appBasePath('/'), '')
    assert.equal(appUrl('/api/health', '/'), '/api/health')
  })

  it('preserves production and canary mount prefixes', () => {
    assert.equal(appBasePath('/feather2/'), '/feather2')
    assert.equal(appUrl('/api/file?path=x', '/feather2/'), '/feather2/api/file?path=x')
    assert.equal(appUrl('/api/rooms', '/canary-zak/'), '/canary-zak/api/rooms')
  })

  it('builds a prefixed websocket URL from the current origin', () => {
    assert.equal(appWebSocketUrl('/api/terminal', {
      protocol: 'https:', host: 'zak.feather-cloud.dev', pathname: '/feather2/',
    }), 'wss://zak.feather-cloud.dev/feather2/api/terminal')
    assert.equal(appWebSocketUrl('/api/shell', {
      protocol: 'http:', host: '127.0.0.1:9000', pathname: '/canary-zak/',
    }), 'ws://127.0.0.1:9000/canary-zak/api/shell')
  })
})
