import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { codexDecoder, createModelRuntime, ModelRunError, parseJsonObject } from '../src/index.js'
import { classifyProcessFailure } from '../src/errors.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url))

function runtimeFor(scenario, options = {}) {
  return createModelRuntime({
    ...options,
    providers: {
      fixture: {
        name: 'fixture',
        prepare() {
          const decoder = codexDecoder()
          return {
            command: process.execPath,
            args: [fixture, scenario],
            decoder,
            finalText: () => decoder.finalText(),
            model: 'fixture-model',
          }
        },
      },
    },
  })
}

const failure = (stderr, exitCode = 1) => classifyProcessFailure({
  aborted: false,
  timedOut: false,
  outputExceeded: false,
  exitCode,
  stderr,
})

// --- Bug 1: stderr classification over-matching ------------------------------

test('routine stderr noise does not classify as an authentication failure', () => {
  assert.equal(failure('token usage: 1234\n'), 'provider_failure')
  assert.equal(failure('authoring complete\n'), 'provider_failure')
  assert.equal(failure('authorizing workspace index...\n'), 'provider_failure')
  assert.equal(failure('author: ada\ntokens: 900\n'), 'provider_failure')
  assert.equal(failure('remaining quota: 4000 tokens\n'), 'provider_failure')
  assert.equal(failure('loaded model gpt-5-codex with access to 3 tools\n'), 'provider_failure')
})

test('genuine authentication failures still classify as authentication', () => {
  for (const stderr of [
    'Error: unauthorized\n',
    'HTTP 401 returned by provider\n',
    'authentication failed\n',
    'you are not logged in\n',
    'invalid api key provided\n',
    'invalid credentials\n',
    'please run `codex login` to continue\n',
    'session expired, re-authenticate and retry\n',
    'request forbidden for this account\n',
  ]) {
    assert.equal(failure(stderr), 'authentication', stderr)
  }
})

test('genuine quota and model failures still classify correctly', () => {
  assert.equal(failure('weekly usage quota exceeded\n'), 'quota')
  assert.equal(failure('429 too many requests\n'), 'quota')
  assert.equal(failure('you have run out of credits\n'), 'quota')
  assert.equal(failure('model gpt-9 not found\n'), 'model_unavailable')
  assert.equal(failure('unknown model: sonnet-99\n'), 'model_unavailable')
})

test('stderr-derived kinds require a nonzero exit code', () => {
  assert.equal(failure('unauthorized\n', 0), 'invalid_output')
  assert.equal(failure('weekly usage quota exceeded\n', 0), 'invalid_output')
})

test('noisy stderr on a failed run surfaces as provider_failure end to end', async () => {
  await assert.rejects(
    runtimeFor('token-noise').run({ provider: 'fixture', prompt: 'hello' }),
    (error) => error instanceof ModelRunError && error.kind === 'provider_failure',
  )
})

// --- Bug 2: brace-scan fabrication -------------------------------------------

test('prose containing braces does not silently yield an object', () => {
  assert.throws(
    () => parseJsonObject('I cannot answer. The shape is {"name": "example"} but I have no data.'),
    /braces in prose/,
  )
})

test('brace scan still recovers JSON surrounded only by insignificant framing', () => {
  assert.deepEqual(parseJsonObject('  \n {"a":1,\n"b":2} \n\n'), { a: 1, b: 2 })
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonObject('Here is the result:\n```json\n{"a":1}\n```\nLet me know.'), { a: 1 })
})

test('brace-scan recovery can be disabled by the caller', () => {
  assert.deepEqual(parseJsonObject('{"a":1}', { allowBraceScan: false }), { a: 1 })
  assert.throws(
    () => parseJsonObject('prefix\n{"a":1,\n"b":2}', { allowBraceScan: false }),
    /brace-scan recovery is disabled/,
  )
})

test('prose with braces fails validation instead of returning fabricated data', async () => {
  await assert.rejects(
    runtimeFor('prose-json').run({
      provider: 'fixture',
      prompt: 'hello',
      // A permissive schema, as tool/function definitions commonly are.
      output: { type: 'json', schema: { type: 'object' } },
    }),
    (error) => error instanceof ModelRunError && error.kind === 'invalid_output',
  )
})

test('a fenced JSON block embedded in prose is still accepted', async () => {
  const result = await runtimeFor('fenced-json').run({
    provider: 'fixture',
    prompt: 'hello',
    output: { type: 'json', schema: { type: 'object', required: ['name'] } },
  })
  assert.deepEqual(result.data, { name: 'Ada', score: 9 })
})

// --- Bug 3: request field injection ------------------------------------------

test('unknown request fields are rejected by name', async () => {
  await assert.rejects(
    runtimeFor('text').run({ provider: 'fixture', prompt: 'hello', sandboxEscape: true }),
    (error) => error instanceof ModelRunError
      && error.kind === 'invalid_request'
      && /sandboxEscape/.test(error.message),
  )
})

test('locked fields reject caller overrides and keep the runtime defaults', async () => {
  process.env.SMR_TEST_SECRET = 'parent-secret'
  try {
    const runtime = runtimeFor('env', {
      defaults: { envPolicy: 'safe', mode: 'read-only' },
      locked: ['mode', 'cwd', 'envPolicy', 'inheritConfig', 'env', 'addDirs'],
    })

    await assert.rejects(
      runtime.run({ provider: 'fixture', prompt: 'hello', envPolicy: 'inherit' }),
      (error) => error instanceof ModelRunError
        && error.kind === 'invalid_request'
        && /locked/.test(error.message)
        && /envPolicy/.test(error.message),
    )
    await assert.rejects(
      runtime.run({ provider: 'fixture', prompt: 'hello', cwd: tmpdir() }),
      (error) => error instanceof ModelRunError && error.kind === 'invalid_request' && /cwd/.test(error.message),
    )
    await assert.rejects(
      runtime.run({ provider: 'fixture', prompt: 'hello', mode: 'workspace-write' }),
      (error) => error instanceof ModelRunError && error.kind === 'invalid_request' && /mode/.test(error.message),
    )
    await assert.rejects(
      runtime.run({ provider: 'fixture', prompt: 'hello', env: { SMR_TEST_SECRET: 'injected' } }),
      (error) => error instanceof ModelRunError && error.kind === 'invalid_request' && /env/.test(error.message),
    )

    // The locked default still applies to a request that does not fight it.
    assert.equal((await runtime.run({ provider: 'fixture', prompt: 'hello' })).text, 'absent')
  } finally {
    delete process.env.SMR_TEST_SECRET
  }
})

test('unlocked fields keep honoring caller input over defaults', async () => {
  process.env.SMR_TEST_SECRET = 'parent-secret'
  try {
    const runtime = runtimeFor('env', { defaults: { envPolicy: 'safe' }, locked: ['mode', 'cwd'] })
    assert.equal((await runtime.run({ provider: 'fixture', prompt: 'hello' })).text, 'absent')
    assert.equal((await runtime.run({
      provider: 'fixture',
      prompt: 'hello',
      envPolicy: 'inherit',
    })).text, 'parent-secret')
  } finally {
    delete process.env.SMR_TEST_SECRET
  }
})

test('locking an unknown field is a construction-time error', () => {
  assert.throws(
    () => runtimeFor('text', { locked: ['notAField'] }),
    (error) => error instanceof ModelRunError && /notAField/.test(error.message),
  )
})
