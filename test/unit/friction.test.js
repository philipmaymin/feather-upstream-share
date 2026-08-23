import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrictionNotes } from '../../lib/friction.js'

describe('parseFrictionNotes', () => {
  it('extracts structured and legacy complaints while ignoring room commentary', () => {
    const notes = [
      '# #friction — notes',
      '- 2026-08-23 12:00 [id:abc123] Complaint from #feather: Browser stalled | Evidence: pthread unavailable',
      '- 2026-08-23 12:01 ROUTED this is triage commentary',
      '- 2026-08-23 12:02 Complaint from #health: Calendar login loop',
    ].join('\n')
    assert.deepEqual(parseFrictionNotes(notes), [
      {
        id: 'abc123', timestamp: '2026-08-23T12:00:00Z', source: 'feather',
        summary: 'Browser stalled', evidence: 'pthread unavailable',
      },
      {
        id: 'legacy-0', timestamp: '2026-08-23T12:02:00Z', source: 'health',
        summary: 'Calendar login loop', evidence: null,
      },
    ])
  })

  it('returns an empty list for absent or unrelated notes', () => {
    assert.deepEqual(parseFrictionNotes(''), [])
    assert.deepEqual(parseFrictionNotes('- 2026-08-23 12:00 fixed something'), [])
  })
})
