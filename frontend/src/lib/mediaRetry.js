export const MEDIA_ATTEMPTS = 3

export class MediaHttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`)
    this.name = 'MediaHttpError'
    this.status = status
  }
}

export function isTransientMediaError(error) {
  if (error instanceof MediaHttpError || Number.isInteger(error?.status)) {
    return [408, 425, 429].includes(error.status) || error.status >= 500
  }
  return error instanceof TypeError || error?.name === 'TimeoutError'
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function retryMediaOperation(operation, {
  attempts = MEDIA_ATTEMPTS,
  sleep = defaultSleep,
  onAttempt = () => {},
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      await onAttempt(attempt, error)
      if (attempt >= attempts || !isTransientMediaError(error)) throw error
      await sleep(350 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 150))
    }
  }
  throw lastError
}

export function runMediaOperationOnce(inFlight, id, operation) {
  const existing = inFlight.get(id)
  if (existing) return existing
  const pending = Promise.resolve().then(operation).finally(() => {
    if (inFlight.get(id) === pending) inFlight.delete(id)
  })
  inFlight.set(id, pending)
  return pending
}

export function isRetryableVoiceMemo(memo) {
  return memo?.status === 'failed' && (
    (typeof memo.transcript === 'string' && memo.transcript.trim().length > 0) ||
    Number(memo?.blob?.size || 0) >= 1000
  )
}
