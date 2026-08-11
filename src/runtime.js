import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Ajv from 'ajv'

import { ModelRunError } from './errors.js'
import { parseJsonObject } from './json.js'
import { runProcess } from './process.js'

export function createModelRuntime({ providers, defaults = {}, spawnFn } = {}) {
  const registry = new Map(Object.entries(providers ?? {}).map(([name, adapter]) => [name, adapter]))
  if (registry.size === 0) throw new Error('createModelRuntime requires at least one provider adapter')
  const validators = new Map()

  return {
    providers: [...registry.keys()],

    capabilities(provider) {
      const adapter = registry.get(provider)
      if (!adapter) throw new Error(`unknown model provider: ${provider}`)
      return { ...(adapter.capabilities ?? {}) }
    },

    async run(input) {
      const request = normalizeRequest(input, defaults)
      const adapter = registry.get(request.provider)
      if (!adapter) throw new ModelRunError('invalid_request', `unknown model provider: ${request.provider}`)
      if (request.output.type === 'json') request.validate = compileValidator(request.output.schema, validators)
      const tempDir = mkdtempSync(join(tmpdir(), 'subscription-model-runtime-'))
      request.writeFile = (path, contents) => writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })

      try {
        let invocation
        try {
          invocation = adapter.prepare(request, tempDir)
        } catch (cause) {
          if (cause instanceof ModelRunError) throw cause
          throw new ModelRunError('invalid_request', cause.message, { cause, provider: request.provider })
        }
        const processResult = await runProcess({
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          env: request.envPolicy === 'inherit'
            ? { ...process.env, ...(request.env ?? {}) }
            : { ...safeEnvironment(process.env), ...(request.env ?? {}) },
          stdin: invocation.stdin ?? request.prompt,
          provider: adapter.name ?? request.provider,
          decoder: invocation.decoder,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          softStallMs: request.softStallMs,
          killGraceMs: request.killGraceMs,
          maxOutputBytes: request.maxOutputBytes,
          maxStderrBytes: request.maxStderrBytes,
          onEvent: request.onEvent,
          spawnFn,
        })

        const providerError = invocation.decoder.error?.()
        if (providerError) {
          throw new ModelRunError('provider_failure', `${request.provider} reported an unsuccessful result`, {
            provider: request.provider,
            command: invocation.command,
            stderr: providerError.slice(0, 4_000),
            partialText: invocation.decoder.partialText?.() ?? '',
          })
        }

        const text = String(invocation.finalText?.() ?? invocation.decoder.finalText?.() ?? '').trim()
        if (!text && request.output.type === 'text') {
          throw new ModelRunError('invalid_output', `${request.provider} returned no final text`, {
            provider: request.provider,
            command: invocation.command,
            stderr: processResult.stderr.slice(-4_000),
            partialText: invocation.decoder.partialText?.() ?? '',
          })
        }

        let data
        if (request.output.type === 'json') {
          try {
            data = invocation.structured?.() ?? parseJsonObject(text)
          } catch (cause) {
            throw new ModelRunError('invalid_output', `${request.provider} returned invalid JSON: ${cause.message}`, {
              cause,
              provider: request.provider,
              command: invocation.command,
              stderr: processResult.stderr.slice(-4_000),
              partialText: text,
            })
          }
          const validate = request.validate
          if (!validate(data)) {
            throw new ModelRunError('schema_validation', `${request.provider} output failed JSON Schema validation`, {
              provider: request.provider,
              command: invocation.command,
              stderr: JSON.stringify(validate.errors).slice(0, 4_000),
              partialText: text,
            })
          }
        }

        return {
          provider: request.provider,
          model: invocation.model ?? request.model ?? null,
          text,
          data,
          durationMs: processResult.durationMs,
          diagnostics: processResult.stderr.slice(-4_000),
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  }
}

function normalizeRequest(input, defaults) {
  if (!input || typeof input !== 'object') throw invalidRequest('model request must be an object')
  if (typeof input.provider !== 'string' || !input.provider) throw invalidRequest('model request requires provider')
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw invalidRequest('model request requires a non-empty prompt')
  const mode = input.mode ?? defaults.mode ?? 'read-only'
  if (!['read-only', 'workspace-write'].includes(mode)) throw invalidRequest('mode must be read-only or workspace-write')
  const output = input.output ?? { type: 'text' }
  if (!['text', 'json'].includes(output.type)) throw invalidRequest('output.type must be text or json')
  if (output.type === 'json' && (!output.schema || typeof output.schema !== 'object')) {
    throw invalidRequest('JSON output requires output.schema')
  }
  if (input.cwd) {
    try {
      if (!statSync(input.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw invalidRequest(`cwd is not an accessible directory: ${input.cwd}`)
    }
  }
  return {
    ...defaults,
    ...input,
    mode,
    output,
    timeoutMs: input.timeoutMs ?? defaults.timeoutMs ?? null,
    softStallMs: input.softStallMs ?? defaults.softStallMs ?? 120_000,
    killGraceMs: input.killGraceMs ?? defaults.killGraceMs ?? 5_000,
    maxOutputBytes: input.maxOutputBytes ?? defaults.maxOutputBytes ?? 64 * 1024 * 1024,
    maxStderrBytes: input.maxStderrBytes ?? defaults.maxStderrBytes ?? 1024 * 1024,
    onEvent: input.onEvent ?? defaults.onEvent ?? (() => {}),
    envPolicy: input.envPolicy ?? defaults.envPolicy ?? 'safe',
  }
}

function compileValidator(schema, validators) {
  const key = JSON.stringify(schema)
  if (validators.has(key)) return validators.get(key)
  try {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
    validators.set(key, validate)
    return validate
  } catch (cause) {
    throw new ModelRunError('invalid_request', `invalid JSON Schema: ${cause.message}`, { cause })
  }
}

function invalidRequest(message) {
  return new ModelRunError('invalid_request', message)
}

function safeEnvironment(source) {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'NO_COLOR', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'KIMI_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]
  return Object.fromEntries(allowed.filter((key) => source[key] != null).map((key) => [key, source[key]]))
}
