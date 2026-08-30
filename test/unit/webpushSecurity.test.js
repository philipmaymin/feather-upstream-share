import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isPublicPushAddress, validPushEndpoint } from '../../lib/webpush.js'

describe('web push network boundary', () => {
  it('rejects private, loopback, link-local, multicast, documentation, and mapped addresses', () => {
    for (const address of [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
      '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
      '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
      'ff02::1', '2001:db8::1', '2002:7f00:1::', '3fff::1',
    ]) assert.equal(isPublicPushAddress(address), false, address)
    assert.equal(isPublicPushAddress('8.8.8.8'), true)
    assert.equal(isPublicPushAddress('2606:4700:4700::1111'), true)
  })

  it('accepts only credential-free HTTPS endpoints with public literal addresses', () => {
    assert.equal(validPushEndpoint('https://push.example.com/subscription'), true)
    assert.equal(validPushEndpoint('https://8.8.8.8/subscription'), true)
    assert.equal(validPushEndpoint('http://push.example.com/subscription'), false)
    assert.equal(validPushEndpoint('https://user:pass@push.example.com/subscription'), false)
    assert.equal(validPushEndpoint('https://127.0.0.1/subscription'), false)
    assert.equal(validPushEndpoint('https://[::1]/subscription'), false)
  })
})
