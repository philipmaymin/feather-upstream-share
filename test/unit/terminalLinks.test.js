import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanTerminalUrl, findHttpUrls, extractHttpUrls, findTerminalLineUrls,
  stripTerminalControlSequences,
} from '../../frontend/src/lib/terminalLinks.js'

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

test('terminal URLs hard-wrapped by a TUI are reconstructed across indented rows', () => {
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_123&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=long_value&originator=pi'
  const width = 52
  const indent = '    '
  const chunks = []
  let remaining = url
  while (remaining.length > width - indent.length) {
    chunks.push(indent + remaining.slice(0, width - indent.length))
    remaining = remaining.slice(width - indent.length)
  }
  chunks.push((indent + remaining).padEnd(width))
  chunks.push('    A browser window should open.'.padEnd(width))

  assert.deepEqual(findTerminalLineUrls(chunks, 20), [{
    url,
    start: { x: 4, y: 20 },
    end: { x: indent.length + remaining.length - 1, y: 20 + chunks.length - 2 },
  }])
})

test('ordinary links do not absorb text from the following terminal row', () => {
  const lines = [
    '  https://example.test/login'.padEnd(52),
    '  Next step'.padEnd(52),
  ]
  assert.deepEqual(findTerminalLineUrls(lines), [{
    url: 'https://example.test/login',
    start: { x: 2, y: 0 },
    end: { x: 27, y: 0 },
  }])
})

test('terminal escape sequences can be stripped before raw URL extraction', () => {
  const url = 'https://auth.example.test/login?state=abc123'
  const output = `\u001b[32m${url.slice(0, 24)}\u001b[0m${url.slice(24)}\u001b[2K`
  assert.equal(stripTerminalControlSequences(output), url)
  assert.deepEqual(extractHttpUrls(stripTerminalControlSequences(output)), [url])
})
