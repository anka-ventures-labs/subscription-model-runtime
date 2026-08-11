# Repository Guidance

- Keep provider drivers thin. Shared lifecycle, safety, parsing, and validation
  belong in the core runtime.
- Never read, copy, log, or package provider credentials. CLIs authenticate
  through their existing local configuration.
- Model names and aliases are caller configuration; do not freeze provider
  release names into the library.
- New provider behavior requires fixture-based contract tests.
- Before each commit, update `docs/SESSION_LOG.md` and durable documentation.
