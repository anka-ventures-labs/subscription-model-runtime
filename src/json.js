export function parseJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (!cleaned) throw new Error('model returned empty JSON output')

  for (const candidate of [cleaned, ...cleaned.split('\n')]) {
    try {
      const parsed = JSON.parse(candidate.trim())
      return parsed
    } catch {
      // Continue to the bounded object fallback.
    }
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return parsed
  }
  throw new Error('model output did not contain valid JSON')
}
