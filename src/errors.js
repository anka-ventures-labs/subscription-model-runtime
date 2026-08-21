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

// Stderr-derived classification is a heuristic over untrusted provider output.
// Substring matching over-triggers badly: a routine "token usage: 1234" line or
// the word "authoring" used to classify as `authentication`, which a calling
// gateway maps to 401 and which can make an upstream proxy cool down or disable
// a healthy deployment. These patterns therefore require a phrase that only
// appears in an actual failure, anchored on word boundaries and constrained to a
// single line so an unrelated later line cannot complete a match.

const QUOTA_PATTERNS = [
  /\b(?:quota|usage limit|usage cap|rate limit|credit balance|credits?)\b[^\n]{0,40}?\b(?:exceeded|exhausted|reached|depleted|too low|insufficient)\b/,
  /\b(?:exceeded|exhausted|ran out of|out of|insufficient|no remaining)\b[^\n]{0,40}?\b(?:quota|usage limit|rate limit|credits?|balance)\b/,
  /\brate[ _-]?limited\b/,
  /\btoo many requests\b/,
  /\bhttp\b[^\n]{0,10}\b429\b|\bstatus(?: code)?\b[^\n]{0,6}\b429\b/,
]

const AUTHENTICATION_PATTERNS = [
  /\b(?:unauthorized|unauthenticated|forbidden)\b/,
  /\bnot (?:logged in|authenticated|authorized)\b/,
  /\b(?:login|log in|sign in|sign-in|authentication|authorization) (?:is )?(?:required|failed|expired)\b/,
  /\bauthentication error\b/,
  /\b(?:invalid|missing|expired|revoked) (?:api[ _-]?key|credentials?|access token|auth token|refresh token|session)\b/,
  /\b(?:api[ _-]?key|credentials?|session|access token|auth token) (?:is |are |has |have )?(?:invalid|missing|expired|revoked)\b/,
  /\bplease (?:run|use)\b[^\n]{0,30}\blogin\b/,
  /\brun\b[^\n]{0,20}\blogin\b[^\n]{0,20}\b(?:to (?:continue|authenticate)|again)\b/,
  /\bre-?authenticate\b/,
  /\bsession (?:has )?expired\b/,
  /\bhttp\b[^\n]{0,10}\b(?:401|403)\b|\bstatus(?: code)?\b[^\n]{0,6}\b(?:401|403)\b/,
]

const MODEL_UNAVAILABLE_PATTERNS = [
  /\bmodel\b[^\n]{0,40}?\b(?:not found|not available|unavailable|unsupported|not supported|does not exist|is invalid|no access|access denied|is not enabled)\b/,
  /\b(?:unknown|unsupported|invalid|unavailable|nonexistent) model\b/,
]

function matchesAny(patterns, detail) {
  return patterns.some((pattern) => pattern.test(detail))
}

export function classifyProcessFailure({ aborted, timedOut, outputExceeded, exitCode, stderr }) {
  if (aborted) return 'cancelled'
  if (timedOut) return 'timeout'
  if (outputExceeded) return 'output_limit'

  // Stderr-derived kinds only describe a *failed* run. A process that exited 0
  // produced usable output regardless of what it logged, so its stderr must
  // never downgrade the result to `authentication` or `quota`.
  if (exitCode === 0) return 'invalid_output'

  const detail = String(stderr ?? '').toLowerCase()
  if (matchesAny(QUOTA_PATTERNS, detail)) return 'quota'
  if (matchesAny(AUTHENTICATION_PATTERNS, detail)) return 'authentication'
  if (matchesAny(MODEL_UNAVAILABLE_PATTERNS, detail)) return 'model_unavailable'
  return 'provider_failure'
}
