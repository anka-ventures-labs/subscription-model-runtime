import { createLineDecoder } from '../lines.js'

export function createClaudeAdapter({ binary = 'claude', defaultModel, aliases = {} } = {}) {
  return {
    name: 'claude',
    capabilities: { sandbox: 'enforced', ephemeral: true, promptTransport: 'stdin', nativeJsonSchema: true },
    prepare(request) {
      const args = [
        '-p', '--no-session-persistence',
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', request.mode === 'read-only' ? 'plan' : 'acceptEdits',
      ]
      if (!request.inheritConfig) {
        args.push('--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}')
      }
      const requestedModel = request.model ?? defaultModel
      const model = requestedModel ? aliases[requestedModel] ?? requestedModel : undefined
      if (model) args.push('--model', model)
      if (request.effort) {
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(request.effort)) {
          throw new Error('Claude effort must be low, medium, high, xhigh, or max')
        }
        args.push('--effort', request.effort)
      }
      if (request.output.type === 'json') args.push('--json-schema', JSON.stringify(request.output.schema))
      args.push('--tools', request.tools === undefined ? 'default' : request.tools.join(','))
      for (const directory of request.addDirs ?? []) args.push('--add-dir', directory)
      const decoder = claudeDecoder()
      return {
        command: binary,
        args,
        cwd: request.cwd,
        decoder,
        finalText: () => decoder.finalText(),
        structured: () => decoder.structured(),
        model,
      }
    },
  }
}

export function claudeDecoder() {
  let partial = ''
  let result = ''
  let structuredOutput
  let failure = ''
  const toolBlocks = new Set()
  const events = []
  const lines = createLineDecoder((line) => {
    let value
    try { value = JSON.parse(line) } catch { return }
    if (value.type === 'stream_event') {
      const event = value.event ?? {}
      const delta = event.delta ?? {}
      if (event.type === 'content_block_delta' && delta.type === 'text_delta' && delta.text) {
        partial += delta.text
        events.push({ type: 'text_delta', text: delta.text })
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolBlocks.add(event.index)
        events.push({ type: 'tool_started', tool: event.content_block.name ?? 'unknown' })
      } else if (event.type === 'content_block_stop' && toolBlocks.delete(event.index)) {
        events.push({ type: 'tool_finished' })
      } else events.push({ type: 'activity', event: event.type ?? 'stream_event' })
    } else if (value.type === 'result') {
      if (typeof value.result === 'string') result = value.result
      structuredOutput = value.structured_output
      if (value.usage) events.push({ type: 'usage', usage: value.usage })
      if (value.is_error) {
        failure = String(value.result ?? 'Claude error')
        events.push({ type: 'provider_error', message: failure })
      }
    } else if (value.type === 'system') {
      events.push({ type: 'initialized', model: value.model, version: value.claude_code_version })
    } else events.push({ type: 'activity', event: value.type ?? 'unknown' })
  })
  return {
    feed(chunk) { lines.write(chunk); return events.splice(0) },
    end() { lines.end(); return events.splice(0) },
    partialText() { return partial || result },
    finalText() { return result || partial },
    structured() { return structuredOutput },
    error() { return failure },
  }
}
