# Migration Guide

## Andy dogfood harness

Replace `runCliProcess`, `runCodexCli`, `runClaudeCli`, and the duplicate
structured-Claude subprocess with one injected runtime. Keep Andy-specific
persona prompts, transcript shaping, and Zod domain validation in Andy.

Map providers as follows:

- `codex_cli` -> `{ provider: 'codex', output: { type: 'text' } }`
- `claude_cli` -> `{ provider: 'claude', output: { type: 'text' } }`
- structured reports -> Claude or Codex with `output.type = 'json'`

Do not migrate the production `live` provider; it is an application API client,
not a subscription CLI.

## Krow

The host-native Codex/Claude subscription transport can invoke `smr` with one
JSON request on stdin and parse one JSON result on stdout. Streaming lifecycle
events optionally use stderr JSONL. Keep persona construction, chat-completion
compatibility envelopes, retries, and evaluation policy in Krow.

## Automarketer

Close over `runtime.run()` inside product `research`, `plan`, and `produce`
functions. Publishing-channel APIs remain separate adapters.

## Rollout

1. Add the package without deleting embedded implementations.
2. Run existing harness fixtures against old and new transports.
3. Compare structured output, cancellation, timeout, and model selection.
4. Switch one low-risk call site.
5. Remove duplicated subprocess code only after parity is proven.

No source application is modified as part of the initial extraction.
