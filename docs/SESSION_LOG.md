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
