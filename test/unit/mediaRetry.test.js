import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { retryMediaOperation, isTransientMediaError, MediaHttpError, runMediaOperationOnce, isRetryableVoiceMemo } from '../../frontend/src/lib/mediaRetry.js'

describe('retryMediaOperation', () => {
  it('makes exactly three total attempts for transient failures', async () => {
    let calls = 0
    const result = await retryMediaOperation(async () => {
      calls++
      if (calls < 3) throw new TypeError('network down')
      return 'ok'
    }, { sleep: async () => {} })

    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  it('retains the third transient error without a fourth attempt', async () => {
    let calls = 0
    await assert.rejects(
      retryMediaOperation(async () => { calls++; throw new MediaHttpError(503, 'unavailable') }, { sleep: async () => {} }),
      /unavailable/,
    )
    assert.equal(calls, 3)
  })

  it('does not retry permanent HTTP failures', async () => {
    let calls = 0
    await assert.rejects(
      retryMediaOperation(async () => { calls++; throw new MediaHttpError(413, 'too large') }, { sleep: async () => {} }),
      /too large/,
    )
    assert.equal(calls, 1)
  })

  it('reports each attempt so durable state can be updated', async () => {
    const seen = []
    await assert.rejects(retryMediaOperation(
      async () => { throw new MediaHttpError(429, 'slow down') },
      { sleep: async () => {}, onAttempt: (attempt, error, willRetry) => seen.push([attempt, error?.status, willRetry]) },
    ))
    assert.deepEqual(seen, [[1, 429, true], [2, 429, true], [3, 429, false]])
  })
})

describe('isTransientMediaError', () => {
  it('retries timeout and selected HTTP statuses only', () => {
    assert.equal(isTransientMediaError(new DOMException('timeout', 'TimeoutError')), true)
    assert.equal(isTransientMediaError(new TypeError('network')), true)
    for (const status of [408, 425, 429, 500, 503]) assert.equal(isTransientMediaError(new MediaHttpError(status, 'x')), true)
    for (const status of [400, 401, 404, 409, 413]) assert.equal(isTransientMediaError(new MediaHttpError(status, 'x')), false)
  })
})

describe('runMediaOperationOnce', () => {
  it('shares one in-flight operation for duplicate record ids and permits a later retry', async () => {
    const inFlight = new Map()
    let calls = 0
    let release
    const operation = () => { calls++; return new Promise(resolve => { release = resolve }) }
    const first = runMediaOperationOnce(inFlight, 'media-1', operation)
    const duplicate = runMediaOperationOnce(inFlight, 'media-1', operation)
    assert.equal(first, duplicate)
    await Promise.resolve()
    assert.equal(calls, 1)
    release('ok')
    assert.equal(await first, 'ok')
    assert.equal(await runMediaOperationOnce(inFlight, 'media-1', async () => { calls++; return 'retried' }), 'retried')
    assert.equal(calls, 2)
  })
})

describe('isRetryableVoiceMemo', () => {
  it('retains too-short recordings without retrying transcription', () => {
    assert.equal(isRetryableVoiceMemo({ status: 'failed', blob: { size: 999 } }), false)
    assert.equal(isRetryableVoiceMemo({ status: 'failed', blob: { size: 1000 } }), true)
    assert.equal(isRetryableVoiceMemo({ status: 'transcribing', blob: { size: 2000 } }), false)
  })

  it('allows retrying delivery when a transcript already exists', () => {
    assert.equal(isRetryableVoiceMemo({ status: 'failed', blob: { size: 10 }, transcript: 'already transcribed' }), true)
  })
})
