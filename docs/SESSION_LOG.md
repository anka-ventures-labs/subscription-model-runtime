# Session Log

## 2026-08-11 - Initial extraction

- Audited Andy's Claude/Codex dogfood transport, its duplicate structured-Claude
  runner, Krow's host-native subscription JSON backend, and the event parsing
  already proven by `atum-agent-jobs`.
- Chose a provider-neutral Node runtime with thin Claude, Codex, and Kimi
  drivers. Model aliases are caller configuration and provider authentication
  remains untouched.
- Added streaming activity, soft-stall/resume events, opt-in hard deadlines,
  AbortSignal cancellation, process-group termination, output limits, typed
  failures, partial-output retention, and AJV JSON Schema validation.
- Kept durable queues and completion delivery out of scope; those remain in the
  agent-jobs supervisor.
- An Opus architecture consultation confirmed the boundary: one shared runtime
  core, thin provider-specific CLI drivers, and application-owned prompts and
  domain policy. Durable queues and notifications remain in `atum-agent-jobs`.
- The first Opus implementation review found provider-default, process cleanup,
  JSON parsing, schema timing, final-record decoding, failure propagation, and
  output-bounding defects. All blocker, high, and medium findings were fixed and
  covered with focused tests.
- A targeted Opus follow-up live-tested all three installed CLIs. It confirmed
  Claude and Codex behavior and found two Kimi 0.34 incompatibilities: prompt
  mode rejects `--auto`, and custom agent files require YAML frontmatter. The
  Kimi adapter and its tests now encode both requirements.
- Verification before the first commit: 27 Node tests pass; all JavaScript files
  pass `node --check`; `npm pack --dry-run` includes only the intended runtime
  files; `npm audit` reports zero vulnerabilities; and the secret-pattern scan
  found no credentials.
- Live smoke tests passed through the public runtime for Claude, Codex, and the
  final corrected Kimi adapter. Structured Claude/Codex responses were schema
  validated, Codex returned the requested exact marker, and Kimi returned
  `SMR_KIMI_OK` in default read-only mode.
- Andy and Krow are intentionally not migrated in this commit. The staged
  migration plan keeps their current transports until parity fixtures pass, so
  extraction does not disrupt active product work.
- Repository checkpoint: the architecture, operating boundaries, migration
  plan, and verification record were committed first on the base branch. The
  runtime implementation, provider drivers, executable fixtures, and test suite
  follow as a separately reviewable feature commit.

## 2026-08-21 - Gateway boundary hardening (`fix/harden-gateway-boundary`)

Context: this library is about to sit behind a long-lived HTTP gateway serving
untrusted request bodies. A review found three defects that are latent for
one-shot CLI use and dangerous behind a server. All three are fixed here.

- `src/errors.js` - `classifyProcessFailure` used bare substring matching.
  `token` matched a routine `token usage: 1234` line and `auth` matched
  `author`/`authoring`/`authorize`, so benign log text classified as
  `authentication`; a gateway maps that to 401 and an LLM proxy can cool down or
  disable a healthy deployment from one noisy line. The `quota` and
  `model_unavailable` patterns had the same defect (`quota` alone matched a
  remaining-quota line; `model.+access` matched almost anything mentioning a
  model). All three are now word-boundary, single-line failure phrases, and the
  stderr-derived kinds are gated on a nonzero exit code so a successful run can
  never be downgraded by its own logs.
- `src/json.js` - the last-resort brace scan sliced from the first `{` to the
  last `}` and parsed it, so prose that happened to contain braces produced a
  plausible object. Combined with a permissive schema (common for tool/function
  definitions) it passed validation and returned silently wrong data - a lie
  rather than an error. The scan now only accepts a span when the discarded
  surrounding material has no letters or digits, and a fenced ```json block
  embedded in prose is extracted explicitly instead of being guessed at.
  `parseJsonObject(text, { allowBraceScan: false })` disables the scan entirely;
  the single-argument call is unchanged, and `createModelRuntime` exposes the
  same switch as `allowBraceScan`.
- `src/runtime.js` - `normalizeRequest` spread caller input into the normalized
  request, so any forwarded body field flowed through. A caller could set
  `envPolicy: 'inherit'` (child receives the full parent environment, including
  operator-exported provider API keys) or `mode: 'workspace-write'` with an
  arbitrary `cwd`. The request is now assembled field-by-field from a closed
  `KNOWN_REQUEST_FIELDS` list with no spread. Unknown keys are **rejected** by
  name rather than dropped: silently dropping lets a caller believe an option
  applied when it did not, and would let an unrecognized field pass unnoticed
  today and become meaningful after a later rename. `createModelRuntime` gained
  `locked: [...]`, which pins fields to their `defaults` value and rejects any
  request that sets one; a safe gateway is one line,
  `locked: ['mode','cwd','envPolicy','inheritConfig','env','addDirs']`. Unlocked
  fields keep their previous caller-over-defaults behavior, and `tools: []`
  still explicitly disables tools.

Also added: `env`, `envPolicy`, `onEvent`, `cwd`, and `output` type checks that
previously relied on downstream code failing later.

Documentation: ARCHITECTURE.md gained invariants 12-14 (closed field list,
locked fields, no fabricated JSON) and a note on stderr classification under the
failure taxonomy. `src/index.d.ts` documents `locked`, `allowBraceScan`, and the
new `parseJsonObject` options argument.

Verification: `npm test` is 41/41 passing (was 27/27); the 14 new tests in
`test/gateway-boundary.test.js` cover the `token usage` false positive, the
exit-code gate, retained true-positive auth/quota/model classification,
prose-with-braces rejection end to end against a permissive `{type:'object'}`
schema, fenced-block recovery, unknown-key rejection by name, and blocked
`envPolicy: 'inherit'` / `cwd` / `mode` / `env` injection under `locked`.
`node --check` is clean on every changed file. Three fixture scenarios
(`token-noise`, `prose-json`, `fenced-json`) were added to
`test/fixtures/fake-cli.js`.

Not fixed, deliberately: `src/cli.js` still `JSON.parse`s stdin and spreads the
parsed object into `runtime.run`, which is now safe (unknown keys are rejected)
but means a stray field turns a whole CLI invocation into an `invalid_request`.
Invariant 10 still stands - this library is not itself a serving gateway, and an
embedder is responsible for authn/z, rate limiting, and prompt-size bounds.

Reviewed in the originating session before commit: diff read in full, tests
re-run independently (41/41), and two items adjusted. Version bumped 0.1.0 ->
0.2.0 because closed-field validation is a breaking change to the documented
`smr` stdin interface, and README now documents that plus the safe-embedding
recipe (`locked` + `allowBraceScan: false`). Invariant 10 was deliberately left
unchanged: the consuming project (synthetic-api) is loopback-only local testing,
so "not a production serving gateway" remains accurate; invariants 12-14 make
safe embedding expressible without claiming production status.

Behavior note not previously recorded: because fields now resolve with
`input[key] ?? defaults[key]`, a caller can no longer pass an explicit `null` to
override a truthy default. `??` semantics mean `tools: []` and
`inheritConfig: false` still override correctly, which are the cases that matter.

Known and deliberately out of scope for this branch: `compileValidator` caches
by `JSON.stringify(schema)` with no eviction, so an embedder accepting
caller-supplied schemas grows the map for the process lifetime. Tracked
separately.

