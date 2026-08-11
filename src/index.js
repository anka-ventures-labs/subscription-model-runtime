export { createModelRuntime } from './runtime.js'
export { ModelRunError } from './errors.js'
export { parseJsonObject } from './json.js'
export { createCodexAdapter, codexDecoder } from './providers/codex.js'
export { createClaudeAdapter, claudeDecoder } from './providers/claude.js'
export { createKimiAdapter, kimiDecoder } from './providers/kimi.js'

import { createModelRuntime } from './runtime.js'
import { createClaudeAdapter } from './providers/claude.js'
import { createCodexAdapter } from './providers/codex.js'
import { createKimiAdapter } from './providers/kimi.js'

export function createDefaultRuntime(options = {}) {
  return createModelRuntime({
    ...options,
    providers: {
      codex: createCodexAdapter(options.codex),
      claude: createClaudeAdapter(options.claude),
      kimi: createKimiAdapter(options.kimi),
      ...(options.providers ?? {}),
    },
  })
}
