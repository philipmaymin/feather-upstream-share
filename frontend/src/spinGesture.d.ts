export type SpinGestureStatus = 'calibrating' | 'armed' | 'triggered'

export interface SpinGestureOptions {
  calibrationMs?: number
  windowMs?: number
  minBaselineDps?: number
  noiseMarginDps?: number
  minExcessDps?: number
  minPeakDps?: number
  minIntegratedDegrees?: number
  minActiveSamples?: number
  maxSampleGapMs?: number
}

export interface SpinGestureSample {
  timestamp: number
  alpha?: number | null
  beta?: number | null
  gamma?: number | null
  accelerationMagnitude?: number
}

export interface SpinGestureResult {
  status: SpinGestureStatus
  triggered: boolean
  baselineDps: number
  integratedDegrees: number
  peakDps: number
  activeSamples: number
}

export interface SpinGestureDetector {
  reset(): void
  sample(reading: SpinGestureSample): SpinGestureResult
  getState(): SpinGestureResult
}

export function createSpinGestureDetector(options?: SpinGestureOptions): SpinGestureDetector
export function motionEventToSpinSample(event: DeviceMotionEvent, timestamp?: number): SpinGestureSample
