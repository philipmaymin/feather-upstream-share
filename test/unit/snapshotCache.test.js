import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshotCache } from '../../lib/snapshot-cache.js'

describe('createSnapshotCache', () => {
  it('loads once and serves the cached snapshot while it is fresh', () => {
    let now = 1_000
    let loads = 0
    const cache = createSnapshotCache(() => ({ version: ++loads }), {
      ttlMs: 10_000,
      now: () => now,
      schedule: () => { throw new Error('fresh cache must not schedule a refresh') },
    })

    assert.deepEqual(cache.get(), { version: 1 })
    now += 9_999
    assert.deepEqual(cache.get(), { version: 1 })
    assert.equal(loads, 1)
  })

  it('returns stale data immediately and coalesces a background refresh', () => {
    let now = 1_000
    let loads = 0
    const scheduled = []
    const cache = createSnapshotCache(() => ({ version: ++loads }), {
      ttlMs: 10_000,
      now: () => now,
      schedule: (fn) => scheduled.push(fn),
    })

    assert.deepEqual(cache.get(), { version: 1 })
    now += 10_001
    assert.deepEqual(cache.get(), { version: 1 })
    assert.deepEqual(cache.get(), { version: 1 })
    assert.equal(loads, 1, 'stale reads must not run the loader inline')
    assert.equal(scheduled.length, 1, 'concurrent stale reads share one refresh')

    scheduled.shift()()
    assert.equal(loads, 2)
    assert.deepEqual(cache.get(), { version: 2 })
  })

  it('invalidates a dependent cache after its source refreshes successfully', () => {
    let now = 1_000
    let sessionVersion = 1
    let sessionLoads = 0
    let roomLoads = 0
    const scheduled = []
    let roomCache
    const sessionsCache = createSnapshotCache(() => {
      sessionLoads++
      return { version: sessionVersion }
    }, {
      ttlMs: 1_000,
      now: () => now,
      schedule: (fn) => scheduled.push(fn),
      onRefresh: () => roomCache?.invalidate(),
    })
    roomCache = createSnapshotCache(() => ({
      sessionVersion: sessionsCache.get().version,
      load: ++roomLoads,
    }), {
      ttlMs: 1_000,
      now: () => now,
      schedule: (fn) => scheduled.push(fn),
    })

    assert.deepEqual(roomCache.get(), { sessionVersion: 1, load: 1 })
    sessionVersion = 2
    now += 1_001

    assert.deepEqual(roomCache.get(), { sessionVersion: 1, load: 1 })
    scheduled.shift()()
    assert.deepEqual(roomCache.get(), { sessionVersion: 1, load: 2 })
    scheduled.shift()()

    assert.deepEqual(roomCache.get(), { sessionVersion: 1, load: 2 })
    assert.deepEqual(roomCache.get(), { sessionVersion: 1, load: 2 })
    assert.equal(scheduled.length, 1, 'dependent stale reads coalesce without a refresh loop')
    scheduled.shift()()

    assert.deepEqual(roomCache.get(), { sessionVersion: 2, load: 3 })
    assert.equal(sessionLoads, 2)
    assert.equal(scheduled.length, 0)
  })

  it('patches a warm snapshot without rerunning the loader', () => {
    let loads = 0
    const cache = createSnapshotCache(() => ({ version: ++loads, enabled: true }), { ttlMs: 10_000 })
    assert.deepEqual(cache.get(), { version: 1, enabled: true })
    cache.update((snapshot) => ({ ...snapshot, enabled: false }))
    assert.deepEqual(cache.get(), { version: 1, enabled: false })
    assert.equal(loads, 1)
  })

  it('keeps the last good snapshot when a background refresh fails', () => {
    let now = 1_000
    let fail = false
    const scheduled = []
    const cache = createSnapshotCache(() => {
      if (fail) throw new Error('transient scan failure')
      return { ok: true }
    }, {
      ttlMs: 10_000,
      now: () => now,
      schedule: (fn) => scheduled.push(fn),
    })

    assert.deepEqual(cache.get(), { ok: true })
    fail = true
    now += 10_001
    assert.deepEqual(cache.get(), { ok: true })
    assert.doesNotThrow(() => scheduled.shift()())
    assert.deepEqual(cache.get(), { ok: true })
  })

  it('can patch a warm snapshot without running the expensive loader again', () => {
    let loads = 0
    const cache = createSnapshotCache(() => {
      loads++
      return ['first']
    }, { ttlMs: 1000 })

    assert.deepEqual(cache.get(), ['first'])
    assert.deepEqual(cache.update(items => ['new', ...items]), ['new', 'first'])
    assert.deepEqual(cache.get(), ['new', 'first'])
    assert.equal(loads, 1)
  })
})
