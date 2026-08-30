import assert from 'node:assert/strict'
import test from 'node:test'

import { createSpinGestureDetector } from '../../frontend/src/spinGesture.js'

function calibrate(detector, speedDps = 8) {
  for (let t = 0; t <= 850; t += 50) {
    detector.sample({ timestamp: t, alpha: speedDps, beta: 0, gamma: 0 })
  }
}

test('calibrates before arming', () => {
  const detector = createSpinGestureDetector()
  let result = detector.sample({ timestamp: 1, alpha: 0, beta: 0, gamma: 0 })
  assert.equal(result.status, 'calibrating')

  result = detector.sample({ timestamp: 900, alpha: 0, beta: 0, gamma: 0 })
  assert.equal(result.status, 'armed')
  assert.equal(result.triggered, false)
})

test('ignores normal handling after calibration', () => {
  const detector = createSpinGestureDetector()
  calibrate(detector)

  let result = detector.getState()
  for (let t = 900; t < 3000; t += 40) {
    result = detector.sample({ timestamp: t, alpha: 45, beta: 35, gamma: 25 })
  }

  assert.equal(result.status, 'armed')
  assert.equal(result.triggered, false)
  assert.ok(result.integratedDegrees < 720)
})

test('triggers on repeated high rotation inside the rolling window', () => {
  const detector = createSpinGestureDetector()
  calibrate(detector)

  let result = detector.getState()
  for (let t = 900; t < 2300 && !result.triggered; t += 16) {
    result = detector.sample({ timestamp: t, alpha: 850, beta: 120, gamma: 0 })
  }

  assert.equal(result.status, 'triggered')
  assert.equal(result.triggered, true)
  assert.ok(result.integratedDegrees >= 720)
  assert.ok(result.peakDps >= 520)
})

test('can report a trigger without committing it', () => {
  const detector = createSpinGestureDetector()
  calibrate(detector)

  let result = detector.getState()
  for (let t = 900; t < 2300 && !result.triggered; t += 16) {
    result = detector.sample({ timestamp: t, alpha: 850, beta: 120, gamma: 0 }, { commitTrigger: false })
  }

  assert.equal(result.status, 'armed')
  assert.equal(result.triggered, true)

  result = detector.sample({ timestamp: 2300, alpha: 900, beta: 0, gamma: 0 }, { commitTrigger: false })
  assert.equal(result.status, 'armed')
  assert.equal(result.triggered, true)
})

test('reset clears a fired detector', () => {
  const detector = createSpinGestureDetector({ minIntegratedDegrees: 180, minPeakDps: 300 })
  calibrate(detector)

  let result = detector.getState()
  for (let t = 900; t < 1400 && !result.triggered; t += 16) {
    result = detector.sample({ timestamp: t, alpha: 700, beta: 0, gamma: 0 })
  }
  assert.equal(result.triggered, true)

  detector.reset()
  result = detector.sample({ timestamp: 1500, alpha: 0, beta: 0, gamma: 0 })
  assert.equal(result.status, 'calibrating')
  assert.equal(result.triggered, false)
})
