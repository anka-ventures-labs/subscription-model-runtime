const FENCED_BLOCK = /```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)```/gi

// Material outside an extracted JSON span is "insignificant" only when it has no
// letters or digits. Whitespace, stray bullet characters, and trailing commas are
// tolerable framing; prose is not.
const SIGNIFICANT_RESIDUE = /[\p{L}\p{N}]/u

/**
 * Parse a model response into JSON.
 *
 * @param {string} text raw model output
 * @param {{ allowBraceScan?: boolean }} [options]
 *   `allowBraceScan` (default `true`) enables the last-resort scan between the
 *   first `{` and the last `}`. Set it to `false` to accept only unambiguous
 *   JSON (a bare document, one JSON line, or a fenced block). Callers behind an
 *   untrusted boundary should disable it.
 */
export function parseJsonObject(text, options = {}) {
  const { allowBraceScan = true } = options ?? {}
  const raw = String(text ?? '')
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (!cleaned) throw new Error('model returned empty JSON output')

  for (const candidate of [cleaned, ...cleaned.split('\n')]) {
    try {
      return JSON.parse(candidate.trim())
    } catch {
      // Continue to the fenced-block and bounded-object fallbacks.
    }
  }

  // A fenced block embedded in prose is an explicit, delimited claim about where
  // the JSON is, so it can be trusted without guessing at boundaries.
  FENCED_BLOCK.lastIndex = 0
  for (const match of cleaned.matchAll(FENCED_BLOCK)) {
    try {
      return JSON.parse(match[1].trim())
    } catch {
      // Try the next fenced block.
    }
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('model output did not contain valid JSON')

  if (!allowBraceScan) {
    throw new Error('model output was not valid JSON and brace-scan recovery is disabled')
  }

  // The brace scan used to splice the widest `{...}` span out of arbitrary prose
  // and return it. Against a permissive schema that produced silently wrong data
  // instead of an error, so the span is now only accepted when nothing
  // meaningful was discarded around it.
  const residue = cleaned.slice(0, start) + cleaned.slice(end + 1)
  if (SIGNIFICANT_RESIDUE.test(residue)) {
    throw new Error('model output embedded JSON-like braces in prose; refusing to guess an object')
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (cause) {
    throw new Error(`model output did not contain valid JSON: ${cause.message}`, { cause })
  }
}
