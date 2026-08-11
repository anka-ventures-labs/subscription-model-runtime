import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { codexDecoder, createKimiAdapter, createModelRuntime, ModelRunError, parseJsonObject } from '../src/index.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url))
const fakeKimi = fileURLToPath(new URL('./fixtures/fake-kimi.js', import.meta.url))

function runtimeFor(scenario, defaults = {}) {
  return createModelRuntime({
    defaults,
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

test('runtime returns a normalized text result', async () => {
  const result = await runtimeFor('text').run({ provider: 'fixture', prompt: 'hello' })
  assert.equal(result.text, 'fixture answer')
  assert.equal(result.model, 'fixture-model')
  assert.equal(result.provider, 'fixture')
})

test('runtime parses and validates JSON-schema output', async () => {
  const result = await runtimeFor('json').run({
    provider: 'fixture',
    prompt: 'hello',
    output: {
      type: 'json',
      schema: {
        type: 'object',
        required: ['name', 'score'],
        properties: { name: { type: 'string' }, score: { type: 'number' } },
      },
    },
  })
  assert.deepEqual(result.data, { name: 'Ada', score: 9 })
})

test('schema failures are typed and retain the model response', async () => {
  await assert.rejects(
    runtimeFor('bad-json').run({
      provider: 'fixture',
      prompt: 'hello',
      output: {
        type: 'json',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    }),
    (error) => error instanceof ModelRunError && error.kind === 'schema_validation' && error.partialText === '{"name":7}',
  )
})

test('quiet work signals a soft stall and resumes without being killed', async () => {
  const events = []
  const result = await runtimeFor('stall').run({
    provider: 'fixture',
    prompt: 'hello',
    softStallMs: 30,
    onEvent: (event) => events.push(event.type),
  })
  assert.equal(result.text, 'awake')
  assert.ok(events.includes('possibly_stalled'))
  assert.ok(events.includes('resumed'))
})

test('hard timeout is opt-in and cancellation preserves partial output', async () => {
  await assert.rejects(
    runtimeFor('partial').run({ provider: 'fixture', prompt: 'hello', timeoutMs: 300 }),
    (error) => error.kind === 'timeout' && error.partialText === 'recoverable partial',
  )

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(
    runtimeFor('partial').run({ provider: 'fixture', prompt: 'hello', signal: controller.signal }),
    (error) => error.kind === 'cancelled' && error.partialText === 'recoverable partial',
  )
})

test('quota and output-limit failures are normalized', async () => {
  await assert.rejects(
    runtimeFor('quota').run({ provider: 'fixture', prompt: 'hello' }),
    (error) => error.kind === 'quota',
  )
  const events = []
  await assert.rejects(
    runtimeFor('large').run({
      provider: 'fixture',
      prompt: 'hello',
      maxOutputBytes: 100,
      onEvent: (event) => events.push(event.type),
    }),
    (error) => error.kind === 'output_limit',
  )
  assert.equal(events.filter((type) => type === 'output_limit').length, 1)
})

test('invalid schemas fail before a provider process is spawned', async () => {
  let spawnCalls = 0
  const runtime = createModelRuntime({
    spawnFn() { spawnCalls += 1; throw new Error('must not spawn') },
    providers: {
      fixture: {
        name: 'fixture',
        prepare() { throw new Error('must not prepare') },
      },
    },
  })
  await assert.rejects(
    runtime.run({ provider: 'fixture', prompt: 'hello', output: { type: 'json', schema: { type: 'not-a-type' } } }),
    (error) => error instanceof ModelRunError && error.kind === 'invalid_request',
  )
  assert.equal(spawnCalls, 0)
})

test('JSON parsing preserves legitimate result fields and accepts arrays', () => {
  assert.deepEqual(parseJsonObject('{"result":{"a":1},"b":2}'), { result: { a: 1 }, b: 2 })
  assert.deepEqual(parseJsonObject('[1,2,3]'), [1, 2, 3])
  assert.deepEqual(parseJsonObject('{"a":1}\n5'), { a: 1 })
})

test('Kimi adapter executes in prompt mode with a valid read-only profile', async () => {
  const runtime = createModelRuntime({
    providers: { kimi: createKimiAdapter({ binary: fakeKimi }) },
  })
  const result = await runtime.run({ provider: 'kimi', prompt: 'hello' })
  assert.equal(result.text, 'fixture kimi answer')
})

test('safe environment policy does not leak unrelated parent secrets', async () => {
  const previous = process.env.SMR_TEST_SECRET
  process.env.SMR_TEST_SECRET = 'parent-secret'
  try {
    assert.equal((await runtimeFor('env').run({ provider: 'fixture', prompt: 'hello' })).text, 'absent')
    assert.equal((await runtimeFor('env').run({
      provider: 'fixture',
      prompt: 'hello',
      env: { SMR_TEST_SECRET: 'explicit-value' },
    })).text, 'explicit-value')
    assert.equal((await runtimeFor('env').run({
      provider: 'fixture',
      prompt: 'hello',
      envPolicy: 'inherit',
    })).text, 'parent-secret')
  } finally {
    if (previous == null) delete process.env.SMR_TEST_SECRET
    else process.env.SMR_TEST_SECRET = previous
  }
})
