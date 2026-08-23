import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanTerminalUrl, findHttpUrls, extractHttpUrls } from '../../frontend/src/lib/terminalLinks.js'

test('terminal login URLs retain OAuth query parameters', () => {
  const url = 'https://console.anthropic.com/oauth/authorize?code=true&client_id=abc_123&state=long-state%2Fvalue'
  assert.deepEqual(findHttpUrls(`Log in here: ${url}\n`), [{ url, index: 13 }])
})

test('terminal URLs shed prose punctuation but retain balanced URL punctuation', () => {
  assert.equal(cleanTerminalUrl('https://example.test/login).'), 'https://example.test/login')
  assert.equal(cleanTerminalUrl('https://example.test/a_(b)'), 'https://example.test/a_(b)')
})

test('terminal URL extraction deduplicates while preserving the latest order', () => {
  assert.deepEqual(extractHttpUrls('https://a.test x https://b.test y https://a.test'), [
    'https://b.test', 'https://a.test',
  ])
})
