## Why

<!--
The problem or need, in 1–3 sentences. Use terms from GLOSSARY.md.
Delete these comments when writing.
-->

## Changes

<!--
Bullets describing behavior that users or the system can see; do not list each file.
A PR that changes structure (call flow, task state transitions, module layout, flow between the CLI, daemon,
worker and GitHub): add the smallest sketch that is clear enough, following src/assets/write-pr/SKILL.md.
-->

## Evidence

<!--
Specific, with before and after: which test that was red is now green, CLI output, a render of a TUI screen.
Do not copy the list of gates that ran; CI and the gates have already recorded them.
State clearly what could not be verified, and any pre-existing failing tests on main.
-->

## Merge risk

**Door:** <!-- one-way | two-way -->

<!--
Two-way: reverting is enough. One-way: reverting leaves behind something that cannot be undone, for example events or
state already written to the store in the new format, cusr.yaml or user config already following the new schema, an
assistant or script already relying on the new CLI/daemon contract, or deleted data. Changing a schema or contract that
no one uses yet is still two-way. For one-way, say where the rollback stops and how to get through safely.
-->

**Impact:** <!-- one phrase: which part breaks if the PR is wrong, e.g. "only the Logs screen", "every running task" -->
