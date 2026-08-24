import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTmuxPaneGeometry, prepareTmuxTerminal, tmuxStatusRows } from '../../lib/terminal-attach.js'

test('tmux status rows account for normal, multi-line, and disabled status bars', () => {
  assert.equal(tmuxStatusRows('on\n'), 1)
  assert.equal(tmuxStatusRows('3\n'), 3)
  assert.equal(tmuxStatusRows('off\n'), 0)
})

test('tmux pane geometry rejects incomplete samples', () => {
  assert.deepEqual(parseTmuxPaneGeometry('52|37|1801\n'), { width: 52, height: 37, history: 1801 })
  assert.equal(parseTmuxPaneGeometry('52|oops|1801'), null)
})

test('same-size terminal attach skips resize and has no settling delay', async () => {
  const calls = []
  const result = await prepareTmuxTerminal('f-same', 52, 38, {
    runTmux: async args => {
      calls.push(args)
      if (args[0] === 'show-options') return 'on\n'
      return '52|37|1801\n'
    },
    sleep: async () => { throw new Error('same-size attach must not sleep') },
  })

  assert.equal(result.resized, false)
  assert.equal(result.settled, true)
  assert.equal(calls.some(args => args[0] === 'resize-window'), false)
})

test('different-size attach waits for repaint history to settle before revealing it', async () => {
  const calls = []
  const samples = [
    '80|24|1950\n',
    '52|37|1950\n',
    '52|37|2000\n',
    '52|37|1870\n',
    '52|37|1870\n',
    '52|37|1870\n',
  ]
  let clock = 0
  const result = await prepareTmuxTerminal('f-reflow', 52, 38, {
    runTmux: async args => {
      calls.push(args)
      if (args[0] === 'show-options') return 'on\n'
      if (args[0] === 'resize-window') return ''
      return samples.shift() || '52|37|1870\n'
    },
    now: () => clock,
    sleep: async ms => { clock += ms },
    pollMs: 50,
    quietMs: 100,
    minimumWaitMs: 150,
    maximumWaitMs: 1_000,
  })

  assert.deepEqual(calls.find(args => args[0] === 'resize-window'), [
    'resize-window', '-t', 'f-reflow', '-x', '52', '-y', '37',
  ])
  assert.equal(result.resized, true)
  assert.equal(result.settled, true)
  assert.equal(result.elapsedMs, 200)
})
