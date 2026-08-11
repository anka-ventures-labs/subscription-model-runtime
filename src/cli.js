#!/usr/bin/env node
import { createDefaultRuntime, ModelRunError } from './index.js'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => controller.abort())
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk

try {
  const request = JSON.parse(raw)
  const stream = request.stream === true
  delete request.stream
  const runtime = createDefaultRuntime()
  const result = await runtime.run({
    ...request,
    signal: controller.signal,
    onEvent: stream
      ? (event) => process.stderr.write(`${JSON.stringify({ event })}\n`)
      : undefined,
  })
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
} catch (error) {
  const detail = error instanceof ModelRunError
    ? {
        kind: error.kind,
        provider: error.provider,
        exitCode: error.exitCode,
        signal: error.signal,
        diagnostics: error.stderr,
        partialText: error.partialText,
      }
    : { kind: 'invalid_request' }
  process.stdout.write(`${JSON.stringify({ ok: false, error: { message: error.message, ...detail } })}\n`)
  process.exitCode = 1
}
