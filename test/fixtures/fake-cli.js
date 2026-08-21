const scenario = process.argv[2]

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (scenario === 'text') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture answer' } })
} else if (scenario === 'json') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: '{"name":"Ada","score":9}' } })
} else if (scenario === 'bad-json') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: '{"name":7}' } })
} else if (scenario === 'stall') {
  await sleep(80)
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'awake' } })
} else if (scenario === 'partial') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'recoverable partial' } })
  await sleep(10_000)
} else if (scenario === 'quota') {
  process.stderr.write('weekly usage quota exceeded\n')
  process.exitCode = 2
} else if (scenario === 'token-noise') {
  process.stderr.write('token usage: 1234\nauthoring complete\nunexpected end of stream\n')
  process.exitCode = 2
} else if (scenario === 'prose-json') {
  emit({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'I cannot complete that request. The expected shape is {"name": "example"} but I have no data to fill it with.',
    },
  })
} else if (scenario === 'fenced-json') {
  emit({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Here is the result:\n```json\n{"name":"Ada","score":9}\n```\n',
    },
  })
} else if (scenario === 'large') {
  process.stdout.write('x'.repeat(20_000))
} else if (scenario === 'env') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: process.env.SMR_TEST_SECRET ?? 'absent' } })
} else {
  process.stderr.write(`unknown fixture scenario: ${scenario}\n`)
  process.exitCode = 3
}
