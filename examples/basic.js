import { createDefaultRuntime } from '../src/index.js'

const provider = process.env.MODEL_PROVIDER
if (!provider) {
  console.error('Set MODEL_PROVIDER to codex, claude, or kimi to run this live example.')
  process.exitCode = 2
} else {
  const runtime = createDefaultRuntime()
  let emittedText = false
  let endsWithNewline = false
  const result = await runtime.run({
    provider,
    model: process.env.MODEL_NAME,
    prompt: 'Return one sentence explaining why explicit failure states matter.',
    mode: 'read-only',
    onEvent(event) {
      if (event.type === 'text_delta' || (event.type === 'text_snapshot' && !emittedText)) {
        process.stdout.write(event.text)
        emittedText = true
        endsWithNewline = event.text.endsWith('\n')
      }
      if (event.type === 'possibly_stalled') console.error('\n[alive but quiet]')
    },
  })
  if (!emittedText) console.log(result.text)
  else if (!endsWithNewline) process.stdout.write('\n')
}
