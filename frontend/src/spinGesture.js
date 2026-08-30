const DEFAULTS = {
  calibrationMs: 800,
  windowMs: 1400,
  minBaselineDps: 90,
  noiseMarginDps: 95,
  minExcessDps: 180,
  minPeakDps: 520,
  minIntegratedDegrees: 720,
  minActiveSamples: 4,
  maxSampleGapMs: 120,
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function vectorNorm(x, y, z) {
  return Math.hypot(finiteNumber(x), finiteNumber(y), finiteNumber(z))
}

function summarize(samples, baselineDps) {
  let integratedDegrees = 0
  let peakDps = 0
  let activeSamples = 0
  for (const sample of samples) {
    integratedDegrees += sample.degrees
    peakDps = Math.max(peakDps, sample.speedDps)
    if (sample.speedDps - baselineDps >= sample.minExcessDps) activeSamples += 1
  }
  return { integratedDegrees, peakDps, activeSamples }
}

export function createSpinGestureDetector(options = {}) {
  const config = { ...DEFAULTS, ...options }
  let startedAt = null
  let lastAt = null
  let calibrated = false
  let baselineDps = config.minBaselineDps
  let calibrationSpeeds = []
  let samples = []
  let triggered = false

  function reset() {
    startedAt = null
    lastAt = null
    calibrated = false
    baselineDps = config.minBaselineDps
    calibrationSpeeds = []
    samples = []
    triggered = false
  }

  function currentStatus() {
    if (triggered) return 'triggered'
    if (calibrated) return 'armed'
    return 'calibrating'
  }

  function result(extra = {}) {
    const summary = summarize(samples, baselineDps)
    return {
      status: currentStatus(),
      triggered,
      baselineDps,
      ...summary,
      ...extra,
    }
  }

  function finishCalibration() {
    const avg = calibrationSpeeds.length
      ? calibrationSpeeds.reduce((sum, speed) => sum + speed, 0) / calibrationSpeeds.length
      : 0
    baselineDps = Math.max(config.minBaselineDps, avg + config.noiseMarginDps)
    calibrated = true
    samples = []
  }

  function sample(reading, options = {}) {
    const commitTrigger = options.commitTrigger !== false
    const now = typeof reading?.timestamp === 'number' && Number.isFinite(reading.timestamp)
      ? reading.timestamp
      : Date.now()
    const speedDps = vectorNorm(reading?.alpha, reading?.beta, reading?.gamma)

    if (startedAt === null) {
      startedAt = now
      lastAt = now
    }

    if (triggered) return result()

    if (!calibrated) {
      calibrationSpeeds.push(speedDps)
      lastAt = now
      if (now - startedAt < config.calibrationMs) return result()
      finishCalibration()
      return result()
    }

    const gapMs = Math.max(0, Math.min(now - (lastAt ?? now), config.maxSampleGapMs))
    lastAt = now

    const excessDps = Math.max(0, speedDps - baselineDps)
    samples.push({
      timestamp: now,
      speedDps,
      degrees: excessDps * (gapMs / 1000),
      minExcessDps: config.minExcessDps,
    })

    const cutoff = now - config.windowMs
    samples = samples.filter(sample => sample.timestamp >= cutoff)

    const summary = summarize(samples, baselineDps)
    const wouldTrigger =
      summary.integratedDegrees >= config.minIntegratedDegrees &&
      summary.peakDps >= config.minPeakDps &&
      summary.activeSamples >= config.minActiveSamples
    if (wouldTrigger && commitTrigger) triggered = true

    return result({ ...summary, triggered: triggered || wouldTrigger })
  }

  return {
    reset,
    sample,
    getState: () => result(),
  }
}

export function motionEventToSpinSample(event, timestamp = Date.now()) {
  const rotationRate = event?.rotationRate || {}
  const acceleration = event?.accelerationIncludingGravity || event?.acceleration || {}
  return {
    timestamp,
    alpha: rotationRate.alpha,
    beta: rotationRate.beta,
    gamma: rotationRate.gamma,
    accelerationMagnitude: vectorNorm(acceleration.x, acceleration.y, acceleration.z),
  }
}
