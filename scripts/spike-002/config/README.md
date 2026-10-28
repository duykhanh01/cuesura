# Harness config templates (unverified)

Flag names come from `--help` of Claude Code 2.1.306 and codex-cli 0.164.0 on the worker
machine on 2026-10-28. Help text is not proof of behaviour. `model` and `binary.sha256` are
`null` on purpose, so `harness.ts check` reports these templates as not ready. The operator
fills in the pinned binary, its hash, the model and the auth files for T007, and keeps every
capability `unknown` until a T006/T007 record proves it. Copy the template outside the repo
before adding auth paths.
