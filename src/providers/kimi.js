import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createLineDecoder } from '../lines.js'

export function createKimiAdapter({ binary = 'kimi', defaultModel, aliases = {} } = {}) {
  return {
    name: 'kimi',
    capabilities: { sandbox: 'advisory', ephemeral: false, promptTransport: 'argv', nativeJsonSchema: false },
    prepare(request, tempDir) {
      const policyPrompt = request.prompt
      const prompt = request.output.type === 'json'
        ? strictJsonPrompt(policyPrompt, request.output.schema)
        : policyPrompt
      const skillsDir = join(tempDir, 'skills')
      mkdirSync(skillsDir, { mode: 0o700 })
      const args = ['--prompt', prompt, '--output-format', 'stream-json', '--skills-dir', skillsDir]
      const requestedModel = request.model ?? defaultModel
      const model = requestedModel ? aliases[requestedModel] ?? requestedModel : undefined
      if (model) args.push('--model', model)
      if (request.mode === 'read-only') {
        const agentPath = join(tempDir, 'read-only-agent.md')
        request.writeFile(agentPath, [
          '---',
          'name: subscription-model-runtime-read-only',
          'description: Read-only profile for unattended subscription-backed model runs',
          'tools:',
          '  - Read',
          '  - ReadMediaFile',
          '  - Grep',
          '  - Glob',
          'disallowedTools:',
          '  - Write',
          '  - Edit',
          '  - Bash',
          '  - Agent',
          '  - AgentSwarm',
          'subagents: []',
          '---',
          '',
          '${base_prompt}',
          '',
          '# Read-only model runner',
          '',
          'Do not create, edit, move, or delete files.',
          'Do not run commands with side effects.',
          'Use tools only to inspect information required by the prompt.',
        ].join('\n'))
        args.push('--agent-file', agentPath)
      }
      if (request.effort) throw new Error('Kimi does not expose a portable effort option')
      for (const directory of request.addDirs ?? []) args.push('--add-dir', directory)
      const decoder = kimiDecoder()
      return {
        command: binary,
        args,
        cwd: request.cwd ?? tempDir,
        stdin: '',
        decoder,
        finalText: () => decoder.finalText(),
        model,
      }
    },
  }
}

export function kimiDecoder() {
  let text = ''
  const events = []
  const lines = createLineDecoder((line) => {
    let value
    try { value = JSON.parse(line) } catch { return }
    if (value.role === 'assistant' && typeof value.content === 'string') {
      text += value.content
      events.push({ type: 'text_delta', text: value.content })
    }
    for (const call of value.tool_calls ?? []) {
      events.push({ type: 'tool_started', tool: call.function?.name ?? call.type ?? 'unknown' })
    }
    if (value.usage) events.push({ type: 'usage', usage: value.usage })
    if (value.role !== 'assistant' && !(value.tool_calls?.length)) {
      events.push({ type: 'activity', event: value.type ?? value.role ?? 'unknown' })
    }
  })
  return {
    feed(chunk) { lines.write(chunk); return events.splice(0) },
    end() { lines.end(); return events.splice(0) },
    partialText() { return text },
    finalText() { return text },
  }
}

function strictJsonPrompt(prompt, schema) {
  return [
    'Return exactly one JSON object matching this JSON Schema. Do not use markdown or prose.',
    JSON.stringify(schema),
    '',
    prompt,
  ].join('\n')
}
