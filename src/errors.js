export class ModelRunError extends Error {
  constructor(kind, message, detail = {}) {
    super(message, detail.cause ? { cause: detail.cause } : undefined)
    this.name = 'ModelRunError'
    this.kind = kind
    this.provider = detail.provider ?? null
    this.command = detail.command ?? null
    this.exitCode = detail.exitCode ?? null
    this.signal = detail.signal ?? null
    this.stderr = detail.stderr ?? ''
    this.partialText = detail.partialText ?? ''
  }
}

export function classifyProcessFailure({ aborted, timedOut, outputExceeded, exitCode, stderr }) {
  if (aborted) return 'cancelled'
  if (timedOut) return 'timeout'
  if (outputExceeded) return 'output_limit'
  const detail = stderr.toLowerCase()
  if (/quota|rate.?limit|usage.?limit|too many requests/.test(detail)) return 'quota'
  if (/auth|login|credential|unauthorized|forbidden|token/.test(detail)) return 'authentication'
  if (/model.+(not found|unavailable|unsupported|access)/.test(detail)) return 'model_unavailable'
  if (exitCode !== 0) return 'provider_failure'
  return 'invalid_output'
}
