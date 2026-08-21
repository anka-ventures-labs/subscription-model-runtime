# Subscription Model Runtime

A provider-neutral local runtime for invoking Claude Code, Codex, and Kimi Code
through their existing subscription-authenticated CLIs.

This is the shared execution layer for local dogfood harnesses, evaluations,
research, extraction, batch workflows, and tools such as Automarketer. It does
not copy credentials, proxy arbitrary external APIs, or provide a production
multi-user model service.

## Why it exists

Provider CLIs differ in command flags, streaming records, structured-output
support, sandbox controls, and failure messages. Applications should not each
reimplement process cleanup, timeout handling, JSONL parsing, and partial-result
recovery.

The core owns:

- subprocess lifecycle and process-tree termination
- streaming normalized events and partial text
- cancellation and optional hard timeouts
- soft-stall signaling without killing quiet work
- output limits and bounded diagnostics
- JSON parsing and JSON Schema validation
- typed provider, quota, authentication, timeout, and output failures

Thin provider drivers own only command construction and event interpretation.

## Usage

Requires Node 22 or newer and whichever provider CLIs you intend to use already
installed and authenticated.

```bash
npm install
npm test
npm link
```

Other local projects can use `npm install /absolute/path/to/subscription-model-runtime`
or a Git dependency. `npm link` exposes the `smr` command on this machine.

```js
import { createDefaultRuntime } from 'subscription-model-runtime'

const models = createDefaultRuntime()
const result = await models.run({
  provider: 'claude',
  model: 'opus',
  prompt: 'Review this architecture.',
  cwd: process.cwd(),
  mode: 'read-only',
  onEvent(event) {
    if (event.type === 'text_delta' || event.type === 'text_snapshot') {
      process.stdout.write(event.text)
    }
    if (event.type === 'possibly_stalled') console.error('Model is alive but quiet')
  },
})
```

Structured output is normalized and validated across providers:

```js
const result = await models.run({
  provider: 'codex',
  prompt: 'Extract the product name and risk level.',
  output: {
    type: 'json',
    schema: {
      type: 'object',
      required: ['product', 'risk'],
      properties: {
        product: { type: 'string' },
        risk: { enum: ['low', 'medium', 'high'] },
      },
    },
  },
})

console.log(result.data)
```

No model is hardcoded. Omit `model` to use the CLI's configured default, pass a
provider-native alias, or configure your own alias map when creating an adapter.

Python and shell consumers can send the same request as JSON over stdin:

```bash
printf '%s' '{"provider":"codex","prompt":"Reply with one word"}' | smr
```

Since 0.2.0 the request is validated against a closed field list. An unrecognized
key is rejected as `invalid_request` naming the key, rather than silently ignored.
This is a breaking change for payloads that carried extra fields.

Embedders exposing this library to untrusted callers should pin the sensitive
fields:

```js
createDefaultRuntime({
  defaults: { mode: 'read-only', envPolicy: 'safe' },
  locked: ['mode', 'cwd', 'envPolicy', 'inheritConfig', 'env', 'addDirs'],
  allowBraceScan: false,
})
```

Kimi does not currently provide sandboxed or ephemeral prompt mode. Inspect
`runtime.capabilities('kimi')` before using it with sensitive workspaces.
Omitting `tools` gives Claude its default tool set; passing `tools: []`
explicitly disables Claude tools.

See [ARCHITECTURE.md](./ARCHITECTURE.md) and
[docs/MIGRATION.md](./docs/MIGRATION.md).
