import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyedLock } from '../../lib/sendlock.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

describe('createKeyedLock (U1 per-session send lock)', () => {
  it('serializes calls sharing a key — no overlap, call order preserved', async () => {
    const lock = createKeyedLock()
    const events = []
    let active = 0
    const task = (tag) => async () => {
      active++
      assert.equal(active, 1, `overlap detected at ${tag}`)
      events.push(`start:${tag}`)
      await delay(20)
      events.push(`end:${tag}`)
      active--
    }
    await Promise.all([lock('a', task('1')), lock('a', task('2')), lock('a', task('3'))])
    assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
  })

  it('runs different keys concurrently', async () => {
    const lock = createKeyedLock()
    let concurrent = 0
    let maxConcurrent = 0
    const task = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await delay(20)
      concurrent--
    }
    await Promise.all([lock('a', task), lock('b', task), lock('c', task)])
    assert.equal(maxConcurrent, 3)
  })

  it('does not deadlock when a locked function throws', async () => {
    const lock = createKeyedLock()
    await assert.rejects(lock('a', async () => { throw new Error('boom') }))
    const ran = await lock('a', async () => 'ok')
    assert.equal(ran, 'ok')
  })
})
