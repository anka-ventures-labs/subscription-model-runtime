import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLineDecoder } from '../lines.js'

export function createCodexAdapter({ binary = 'codex', defaultModel, aliases = {} } = {}) {
  return {
    name: 'codex',
    capabilities: { sandbox: 'enforced', ephemeral: true, promptTransport: 'stdin', nativeJsonSchema: true },
    prepare(request, tempDir) {
      const outputPath = join(tempDir, 'last-message.txt')
      const args = [
        'exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--json',
        '--sandbox', request.mode,
        '--output-last-message', outputPath,
      ]
      if (!request.inheritConfig) args.push('--ignore-user-config', '--ignore-rules')
      const model = resolveModel(request.model ?? defaultModel, aliases)
      if (model) args.push('--model', model)
      if (request.effort) args.push('-c', `model_reasoning_effort=${request.effort}`)
      if (request.cwd) args.push('--cd', request.cwd)
      for (const image of request.images ?? []) args.push('--image', image)
      if (request.output.type === 'json') {
        const schemaPath = join(tempDir, 'schema.json')
        request.writeFile(schemaPath, JSON.stringify(request.output.schema))
        args.push('--output-schema', schemaPath)
      }
      args.push('-')
      const decoder = codexDecoder()
      return {
        command: binary,
        args,
        cwd: request.cwd,
        decoder,
        finalText: () => readOptional(outputPath) || decoder.finalText(),
        model,
      }
    },
  }
}

export function codexDecoder() {
  let text = ''
  let failure = ''
  const events = []
  const lines = createLineDecoder((line) => {
    let value
    try { value = JSON.parse(line) } catch { return }
    const item = value.item ?? {}
    if (value.type === 'item.completed' && item.type === 'agent_message' && item.text) {
      text = String(item.text)
      events.push({ type: 'text_snapshot', text })
    } else if (value.type === 'item.started') {
      events.push({ type: 'tool_started', tool: item.type ?? 'unknown' })
    } else if (value.type === 'item.completed' && item.type !== 'agent_message') {
      events.push({ type: 'tool_finished', tool: item.type ?? 'unknown', exitCode: item.exit_code ?? null })
    } else if (value.type === 'turn.completed') {
      events.push({ type: 'usage', usage: value.usage ?? {} })
    } else if (value.type === 'turn.failed') {
      failure = typeof value.error === 'string'
        ? value.error
        : value.error?.message ?? value.message ?? 'Codex turn failed'
      events.push({ type: 'provider_error', message: failure })
    } else {
      events.push({ type: 'activity', event: value.type ?? 'unknown' })
    }
  })
  return {
    feed(chunk) { lines.write(chunk); return events.splice(0) },
    end() { lines.end(); return events.splice(0) },
    partialText() { return text },
    finalText() { return text },
    error() { return failure },
  }
}

function resolveModel(model, aliases) {
  return model ? aliases[model] ?? model : undefined
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}
