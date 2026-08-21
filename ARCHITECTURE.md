# Architecture

## Layers

1. Applications express one normalized request and consume normalized events.
2. The runtime validates policy, creates private temporary files, supervises the
   subprocess, validates output, and removes temporary state.
3. Provider drivers translate the request into current CLI flags and decode
   provider records.
4. Claude, Codex, and Kimi continue to own authentication and model routing.

This library is below durable orchestration. Long-running queues, job ownership,
notifications, retained journals, and cross-session delivery remain concerns of
systems such as `atum-agent-jobs`.

## Provider differences

| Capability | Codex | Claude | Kimi |
| --- | --- | --- | --- |
| Noninteractive mode | `codex exec` | `claude -p` | `kimi --prompt` |
| Stream | `--json` JSONL | `stream-json` with partial messages | `stream-json` |
| Structured output | schema file | inline JSON Schema | prompt contract + runtime validation |
| Read-only policy | `--sandbox read-only` | plan permission mode | advisory prompt only |
| Subscription auth | existing `CODEX_HOME` | existing Claude login | existing Kimi login |

Kimi prompt mode currently has no sandbox flag, cannot combine `--plan` with
`--prompt`, exposes its prompt in process arguments, and has no ephemeral mode.
The adapter reports these limitations through capability metadata and never
claims that Kimi read-only mode is enforced.

Model aliases are passed through. Adapter-level alias maps are configuration,
not a release-name table embedded in the package.

Provider/project configuration is isolated by default: Codex ignores user
execution config and rules, Claude starts in safe mode with a strict empty MCP
set, and Kimi receives a private temporary agent definition. Callers may set
`inheritConfig: true` where project instructions are intentionally part of the
model context.

Claude receives its default tool set when `tools` is omitted. Passing
`tools: []` explicitly disables tools. Kimi prompt mode runs unattended without
interactive permission flags; its temporary agent profile has a restricted tool
allowlist, but that read-only policy remains advisory rather than enforced.

Normalized semantic text events are `text_delta` for Claude and Kimi, and
`text_snapshot` for Codex. Consumers that display live output should accept
both forms and avoid replaying the final result after streaming it.

## Failure taxonomy

`ModelRunError.kind` is one of:

- `spawn`
- `cancelled`
- `timeout`
- `output_limit`
- `quota`
- `authentication`
- `model_unavailable`
- `provider_failure`
- `invalid_request`
- `invalid_output`
- `schema_validation`

Stderr-derived kinds (`quota`, `authentication`, `model_unavailable`) are a
heuristic over untrusted provider output and are only considered when the
process exited nonzero. The patterns require a failure phrase on word
boundaries within a single line; routine log text such as `token usage: 1234`
or `authoring complete` must classify as `provider_failure`, never as
`authentication`, because callers map that kind to 401 and upstream proxies may
disable a healthy deployment on it.

Errors retain bounded diagnostics and `partialText`. Prompts, tool inputs, CLI
arguments, credentials, and raw provider event streams are not placed in
normalized events. Raw provider stderr is returned as `diagnostics` and may
echo provider arguments; callers must treat it as sensitive.

## Invariants

1. There is no default hard timeout. Quiet work is visible but not killed.
2. Cancellation and explicit timeout terminate the process group, then escalate
   to `SIGKILL` after a grace period.
3. Partial semantic output survives cancellation and provider failure.
4. Output bytes are bounded independently from bounded stderr diagnostics.
5. JSON output is validated in the runtime even when a provider supports native
   schema enforcement.
6. Temporary schemas and output files use private permissions and are removed.
7. Credentials remain in provider-owned local stores; the runtime never reads or
   copies them.
8. Read-only is the default. Workspace writes require an explicit request.
9. Provider events expose tool names and lifecycle only, never tool arguments.
10. The library is local/internal tooling, not a production serving gateway.
11. The default child environment is allowlisted; unrelated parent-process
    secrets are not inherited. Explicit environment additions remain possible.
12. The normalized request is built field-by-field from a closed known-field
    list. Caller input is never spread into it, so no unrecognized key can reach
    the runtime, an adapter, or the child process. An unknown field is rejected
    as `invalid_request` naming the key rather than dropped, so a caller can
    never believe an option applied when it did not.
13. `createModelRuntime({ locked: [...] })` pins request fields to their
    `defaults` value. A request that sets a locked field is rejected as
    `invalid_request`. An embedder exposing this library to untrusted callers
    should use `locked: ['mode', 'cwd', 'envPolicy', 'inheritConfig', 'env',
    'addDirs']`; unlocked fields keep their previous caller-over-defaults
    precedence.
14. JSON recovery never fabricates an object. Beyond a bare JSON document, a
    single JSON line, and a fenced block, the `{...}` brace scan is accepted
    only when the discarded surrounding material contains no letters or digits.
    Braces embedded in prose raise `invalid_output` instead of returning a
    plausible object that a permissive schema would accept. The scan can be
    disabled entirely with `allowBraceScan: false`.
