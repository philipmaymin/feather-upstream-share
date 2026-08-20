import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// lib/sidecar.js resolves its state dir from HOME at import time, so point HOME
// at a throwaway dir before importing it — keeps the test off the real store.
let sc
let tmpHome

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'))
  process.env.HOME = tmpHome
  sc = await import('../../lib/sidecar.js')
})

after(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {} })

describe('sidecar store (v1 + v2 multi-peer)', () => {
  it('creates a group; rejects duplicate / invalid / reserved roles', () => {
    const g = sc.createGroup({
      id: 'g1',
      members: [
        { sessionId: 'aaaaaaaa-1', role: 'generator', spawned: false },
        { sessionId: 'bbbbbbbb-2', role: 'critic-sec', spawned: true },
      ],
      agent: 'claude',
    })
    assert.equal(g.members.length, 2)
    assert.equal(g.seq, 0)
    assert.throws(() => sc.createGroup({ id: 'gx', members: [{ sessionId: 'x', role: 'peer' }, { sessionId: 'y', role: 'peer' }] }), /duplicate/)
    assert.throws(() => sc.createGroup({ id: 'gy', members: [{ sessionId: 'x', role: 'bad role' }] }), /invalid role/)
    assert.throws(() => sc.createGroup({ id: 'gz', members: [{ sessionId: 'x', role: 'all' }] }), /reserved/)
  })

  it('appendMessage stamps a monotonic seq', () => {
    const a = sc.appendMessage('g1', { from: 'generator', to: 'critic-sec', text: 'one' })
    const b = sc.appendMessage('g1', { from: 'critic-sec', to: 'generator', text: 'two' })
    assert.equal(a.seq, 1)
    assert.equal(b.seq, 2)
    const t = sc.readThread('g1')
    assert.equal(t.length, 2)
    assert.equal(t[1].seq, 2)
  })

  it('resolveRecipients: single, comma-list, all-excludes-sender, missing', () => {
    sc.addMember('g1', { sessionId: 'cccccccc-3', role: 'critic-perf', spawned: true })
    const g = sc.getGroup('g1')
    assert.deepEqual(sc.resolveRecipients(g, 'critic-sec', 'generator').targets.map(m => m.role), ['critic-sec'])
    assert.deepEqual(sc.resolveRecipients(g, 'critic-sec,critic-perf', 'generator').targets.map(m => m.role), ['critic-sec', 'critic-perf'])
    const all = sc.resolveRecipients(g, 'all', 'generator')
    assert.deepEqual(all.targets.map(m => m.role).sort(), ['critic-perf', 'critic-sec'])
    assert.ok(!all.targets.some(m => m.role === 'generator'), 'all must exclude the sender')
    const miss = sc.resolveRecipients(g, 'nobody', 'generator')
    assert.deepEqual(miss.missing, ['nobody'])
    assert.equal(miss.targets.length, 0)
  })

  it('addMember rejects a dup role; removeMember drops it', () => {
    assert.throws(() => sc.addMember('g1', { sessionId: 'z', role: 'critic-sec' }), /duplicate/)
    sc.addMember('g1', { sessionId: 'dddddddd-4', role: 'critic-temp', spawned: true })
    assert.ok(sc.getGroup('g1').members.some(m => m.role === 'critic-temp'))
    sc.removeMember('g1', 'critic-temp')
    assert.ok(!sc.getGroup('g1').members.some(m => m.role === 'critic-temp'))
  })

  it('groupForSenderAndRole disambiguates a multi-group sender by target role', () => {
    sc.createGroup({
      id: 'g2',
      members: [
        { sessionId: 'aaaaaaaa-9', role: 'generator', spawned: false },
        { sessionId: 'eeeeeeee-5', role: 'reviewer', spawned: true },
      ],
    })
    // sender 'aaaaaaaa' is in both g1 and g2; the target role picks the group
    assert.equal(sc.groupForSenderAndRole('aaaaaaaa', 'reviewer').id, 'g2')
    assert.equal(sc.groupForSenderAndRole('aaaaaaaa', 'critic-sec').id, 'g1')
    // ambiguous: broadcast with a multi-group sender → null (caller must pass group)
    assert.equal(sc.groupForSenderAndRole('aaaaaaaa', 'all'), null)
    // single-group sender resolves directly
    assert.equal(sc.groupForSenderAndRole('cccccccc', 'all').id, 'g1')
  })

  it('priming names the roster and adds the broadcast hint only with 2+ others', () => {
    const p = sc.priming({ selfRole: 'generator', roster: ['generator', 'critic-sec', 'critic-perf'], task: 'do X' })
    assert.match(p, /critic-sec/)
    assert.match(p, /critic-perf/)
    assert.match(p, /--to all/)
    assert.match(p, /do X/)
    const p2 = sc.priming({ selfRole: 'a', roster: ['a', 'b'] })
    assert.doesNotMatch(p2, /--to all/)
  })
})
