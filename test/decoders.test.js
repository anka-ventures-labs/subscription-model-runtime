import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeDecoder, codexDecoder, kimiDecoder } from '../src/index.js'

test('Codex decoder handles split JSONL and keeps the final agent message', () => {
  const decoder = codexDecoder()
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } })
  assert.deepEqual(decoder.feed(line.slice(0, 20)), [])
  const events = decoder.feed(`${line.slice(20)}\n`)

  assert.equal(events[0].type, 'text_snapshot')
  assert.equal(decoder.finalText(), 'ready')
})

test('Claude decoder streams deltas but trusts the terminal result', () => {
  const decoder = claudeDecoder()
  const records = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ' } } },
    { type: 'result', result: 'partial answer', structured_output: { answer: 1 } },
  ]
  const events = decoder.feed(`${records.map(JSON.stringify).join('\n')}\n`)

  assert.equal(events[0].type, 'text_delta')
  assert.equal(decoder.partialText(), 'partial ')
  assert.equal(decoder.finalText(), 'partial answer')
  assert.deepEqual(decoder.structured(), { answer: 1 })
})

test('Claude decoder exposes unsuccessful result envelopes even with a zero process exit', () => {
  const decoder = claudeDecoder()
  decoder.feed(`${JSON.stringify({ type: 'result', is_error: true, result: 'model unavailable' })}\n`)

  assert.equal(decoder.error(), 'model unavailable')
})

test('Claude emits tool completion only for tool blocks', () => {
  const decoder = claudeDecoder()
  const records = [
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Read' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  ]
  const events = decoder.feed(`${records.map(JSON.stringify).join('\n')}\n`)
  assert.equal(events.filter((event) => event.type === 'tool_finished').length, 1)
})

test('decoder end returns events from an unterminated final JSONL record', () => {
  const decoder = codexDecoder()
  decoder.feed(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last' } }))
  assert.deepEqual(decoder.end(), [{ type: 'text_snapshot', text: 'last' }])
})

test('Codex exposes turn failures even when the process exits zero', () => {
  const decoder = codexDecoder()
  decoder.feed(`${JSON.stringify({ type: 'turn.failed', error: { message: 'model failed' } })}\n`)
  assert.equal(decoder.error(), 'model failed')
})

test('Kimi decoder assembles incremental assistant records without exposing tool input', () => {
  const decoder = kimiDecoder()
  const records = [
    { role: 'assistant', content: 'partial ', tool_calls: [{ function: { name: 'ReadFile', arguments: 'private' } }] },
    { role: 'assistant', content: 'answer' },
  ]
  const events = decoder.feed(`${records.map(JSON.stringify).join('\n')}\n`)

  assert.equal(decoder.finalText(), 'partial answer')
  assert.ok(events.some((event) => event.type === 'tool_started' && event.tool === 'ReadFile'))
  assert.equal(JSON.stringify(events).includes('private'), false)
})
