import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import featherCommunicationTools from '../../omp-tools/feather-communication.js'

function fakeSchema() {
  return {
    min() { return this },
    max() { return this },
    optional() { return this },
  }
}

function makePi({ cwd = '/home/user/rooms/feather', execResult, execImpl, onExec } = {}) {
  const source = cwd.split('/').filter(Boolean).at(-1) || 'unscoped'
  const wake = source === 'friction' ? 'wake skipped' : 'wake requested'
  return {
    cwd,
    zod: {
      string: () => fakeSchema(),
      object: (shape) => ({ shape }),
    },
    exec: async (command, args, options) => {
      onExec?.(command, args, options)
      if (execImpl) return execImpl(command, args, options)
      return execResult || { code: 0, stdout: `flagged in #friction from #${source} (${wake})\n`, stderr: '', killed: false }
    },
  }
}

const byName = (tools, name) => tools.find((tool) => tool.name === name)

describe('Feather OMP communication tools', () => {
  it('exposes both tools as essential literal model-callable tools', () => {
    const tools = featherCommunicationTools(makePi())
    assert.deepEqual(tools.map((tool) => tool.name), ['tell_user', 'report_friction'])
    assert.ok(tools.every((tool) => tool.loadMode === 'essential'))
    assert.ok(byName(tools, 'tell_user').parameters.shape.message)
    assert.ok(byName(tools, 'report_friction').parameters.shape.summary)
  })

  it('tell_user returns a structured transient status keyed by tool-call id', async () => {
    const tellUser = byName(featherCommunicationTools(makePi()), 'tell_user')
    const result = await tellUser.execute('status-123', { message: '  Testing the mobile layout now.  ' })
    assert.deepEqual(result.details, {
      kind: 'tell_user', statusId: 'status-123', message: 'Testing the mobile layout now.',
    })
    assert.match(result.content[0].text, /shown to the user/i)
    await assert.rejects(tellUser.execute('status-124', { message: '   ' }), /must not be empty/)
  })

  it('report_friction routes safely to the source room with idempotency id and evidence', async () => {
    let call
    const pi = makePi({
      onExec: (command, args, options) => { call = { command, args, options } },
    })
    const report = byName(featherCommunicationTools(pi), 'report_friction')
    const result = await report.execute(
      'friction-123',
      { summary: ' Browser daemon stalled ', evidence: ' pthread_create:\n resource unavailable ' },
      undefined, undefined, AbortSignal.timeout(1000),
    )
    assert.equal(call.command, 'room')
    assert.match(result.details.reportId, /^[a-f0-9]{32}$/)
    assert.deepEqual(call.args, [
      'complain', '--id', result.details.reportId, '--',
      'Browser daemon stalled | Evidence: pthread_create: resource unavailable',
    ])
    assert.equal(call.options.cwd, '/home/user/rooms/feather')
    assert.deepEqual(result.details, {
      kind: 'report_friction', reportId: result.details.reportId, sourceToolCallId: 'friction-123',
      source: 'feather', destination: 'friction', wakeRequested: true, duplicate: false,
      cwd: '/home/user/rooms/feather',
    })
  })

  it('terminates CLI option parsing before option-like complaint text', async () => {
    let args
    const pi = makePi({ onExec: (_command, value) => { args = value } })
    const report = byName(featherCommunicationTools(pi), 'report_friction')
    await report.execute('friction-option-text', { summary: '--no-wake' })
    assert.deepEqual(args.slice(-2), ['--', '--no-wake'])
  })

  it('falls back to an explicit sanitized source outside the Rooms tree', async () => {
    const calls = []
    const pi = makePi({
      cwd: '/home/user/project with spaces',
      execImpl: async (_command, args) => {
        calls.push(args)
        if (calls.length === 1) return { code: 1, stdout: '', stderr: 'room: not inside a room', killed: false }
        return { code: 0, stdout: 'flagged in #friction from #project-with-spaces (wake requested)\n', stderr: '', killed: false }
      },
    })
    const report = byName(featherCommunicationTools(pi), 'report_friction')
    const result = await report.execute('friction-unscoped', { summary: 'Global OMP failure' })
    assert.deepEqual(calls[0].slice(0, 2), ['complain', '--id'])
    assert.deepEqual(calls[1], [
      'complain', '--id', result.details.reportId, '--source', 'project-with-spaces', '--', 'Global OMP failure',
    ])
    assert.equal(result.details.source, 'project-with-spaces')
  })

  it('a report originating in #friction records a note without recursively waking itself', async () => {
    let args
    const pi = makePi({ cwd: '/home/user/rooms/friction', onExec: (_command, value) => { args = value } })
    const report = byName(featherCommunicationTools(pi), 'report_friction')
    const result = await report.execute('friction-self', { summary: 'The triage parser broke' })
    assert.deepEqual(args, [
      'complain', '--id', result.details.reportId, '--', 'The triage parser broke',
    ])
    assert.equal(result.details.wakeRequested, false)
  })

  it('does not claim success when room persistence fails', async () => {
    const pi = makePi({ execResult: { code: 1, stdout: '', stderr: 'disk full', killed: false } })
    const report = byName(featherCommunicationTools(pi), 'report_friction')
    await assert.rejects(report.execute('friction-fail', { summary: 'Cannot persist state' }), /disk full/)
  })
})
