#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]

if (!args.includes('--prompt') || !args.includes('--output-format')) {
  process.stderr.write('missing prompt-mode flags\n')
  process.exit(2)
}
if (args.includes('--auto') || args.includes('--yolo')) {
  process.stderr.write('Cannot combine --prompt with interactive permission flags\n')
  process.exit(2)
}

const agentPath = valueAfter('--agent-file')
if (!agentPath || !readFileSync(agentPath, 'utf8').startsWith('---\n')) {
  process.stderr.write('Invalid agent file: Missing frontmatter\n')
  process.exit(2)
}

process.stdout.write(`${JSON.stringify({ role: 'assistant', content: 'fixture kimi answer' })}\n`)
