import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Ajv from 'ajv'

import { ModelRunError } from './errors.js'
import { parseJsonObject } from './json.js'
import { runProcess } from './process.js'

export function createModelRuntime({ providers, defaults = {}, locked = [], allowBraceScan = true, spawnFn } = {}) {
  const registry = new Map(Object.entries(providers ?? {}).map(([name, adapter]) => [name, adapter]))
  if (registry.size === 0) throw new Error('createModelRuntime requires at least one provider adapter')
  const validators = new Map()
  const lockedFields = normalizeLockedFields(locked)
  assertKnownFields(defaults, 'defaults')

  return {
    providers: [...registry.keys()],

    capabilities(provider) {
      const adapter = registry.get(provider)
      if (!adapter) throw new Error(`unknown model provider: ${provider}`)
      return { ...(adapter.capabilities ?? {}) }
    },

    async run(input) {
      const request = normalizeRequest(input, defaults, lockedFields)
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
            data = invocation.structured?.() ?? parseJsonObject(text, { allowBraceScan })
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

// The complete set of request fields the runtime understands. The normalized
// request is built field-by-field from this list rather than by spreading
// caller input: an embedder behind an HTTP gateway commonly forwards the whole
// request body, and a spread would let an untrusted caller reach
// `envPolicy: 'inherit'` (full parent environment, including provider API keys)
// or `mode: 'workspace-write'` plus an arbitrary `cwd`.
const KNOWN_REQUEST_FIELDS = Object.freeze([
  'provider', 'prompt', 'model', 'effort', 'cwd', 'mode', 'tools', 'images', 'addDirs',
  'output', 'signal', 'timeoutMs', 'softStallMs', 'killGraceMs', 'maxOutputBytes',
  'maxStderrBytes', 'env', 'envPolicy', 'inheritConfig', 'onEvent',
])

const KNOWN_REQUEST_FIELD_SET = new Set(KNOWN_REQUEST_FIELDS)

const REQUEST_FALLBACKS = Object.freeze({
  mode: 'read-only',
  timeoutMs: null,
  softStallMs: 120_000,
  killGraceMs: 5_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  envPolicy: 'safe',
})

function assertKnownFields(source, label) {
  if (!source || typeof source !== 'object') return
  for (const key of Object.keys(source)) {
    if (!KNOWN_REQUEST_FIELD_SET.has(key)) {
      throw new ModelRunError('invalid_request', `unknown model request field in ${label}: ${key}`)
    }
  }
}

function normalizeLockedFields(locked) {
  if (locked == null) return new Set()
  if (!Array.isArray(locked)) throw new ModelRunError('invalid_request', 'locked must be an array of request field names')
  for (const key of locked) {
    if (!KNOWN_REQUEST_FIELD_SET.has(key)) {
      throw new ModelRunError('invalid_request', `cannot lock unknown model request field: ${key}`)
    }
  }
  return new Set(locked)
}

function normalizeRequest(input, defaults, locked = new Set()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRequest('model request must be an object')

  // Unknown keys are rejected rather than dropped. Silently dropping them lets a
  // caller believe an option took effect when it did not, and it would let a
  // future field name pass through unnoticed today and become meaningful later.
  // Failing loudly keeps the trust boundary explicit.
  for (const key of Object.keys(input)) {
    if (!KNOWN_REQUEST_FIELD_SET.has(key)) throw invalidRequest(`unknown model request field: ${key}`)
  }
  for (const key of locked) {
    if (input[key] !== undefined) {
      throw invalidRequest(`model request field is locked by this runtime and cannot be set by the caller: ${key}`)
    }
  }

  const request = {}
  for (const key of KNOWN_REQUEST_FIELDS) {
    const value = locked.has(key) ? defaults[key] : (input[key] ?? defaults[key])
    const resolved = value ?? REQUEST_FALLBACKS[key]
    if (resolved !== undefined) request[key] = resolved
  }
  request.timeoutMs = request.timeoutMs ?? null
  request.output = request.output ?? { type: 'text' }
  request.onEvent = request.onEvent ?? (() => {})

  if (typeof request.provider !== 'string' || !request.provider) throw invalidRequest('model request requires provider')
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw invalidRequest('model request requires a non-empty prompt')
  if (!['read-only', 'workspace-write'].includes(request.mode)) throw invalidRequest('mode must be read-only or workspace-write')
  if (!request.output || typeof request.output !== 'object') throw invalidRequest('output must be an object')
  if (!['text', 'json'].includes(request.output.type)) throw invalidRequest('output.type must be text or json')
  if (request.output.type === 'json' && (!request.output.schema || typeof request.output.schema !== 'object')) {
    throw invalidRequest('JSON output requires output.schema')
  }
  if (request.env != null && (typeof request.env !== 'object' || Array.isArray(request.env))) {
    throw invalidRequest('env must be an object of environment variables')
  }
  if (!['safe', 'inherit'].includes(request.envPolicy)) throw invalidRequest('envPolicy must be safe or inherit')
  if (typeof request.onEvent !== 'function') throw invalidRequest('onEvent must be a function')
  if (request.cwd != null) {
    if (typeof request.cwd !== 'string') throw invalidRequest('cwd must be a string path')
    try {
      if (!statSync(request.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw invalidRequest(`cwd is not an accessible directory: ${request.cwd}`)
    }
  }
  return request
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
