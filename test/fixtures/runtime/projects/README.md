# Smoke fixtures (T121)

Two small projects with no dependencies, used by `test/smoke/`. Each project contains:

- `repo/`: the initial content of the sandbox repo, including `cusr.yaml` and the CI workflow. The gate for `repo/` is green.
- `task.json`: a real task handed to the coder, the input to `cusr task add --file`.
- `variants/pass/`: a correct solution. Copying it over `repo/` makes the gate green.
- `variants/fail/`: the same tests, but a wrong solution. Copying it over `repo/` makes the `unit` gate red while the other gates stay green.

`prompts/` holds the role prompts placed next to the user config. No file here contains credentials; the user config of a
real run only names the path to the credentials (`runtime.credential_refs`).

## Real run (opt-in)

`pnpm test:smoke` does not call a model if `CUSR_SMOKE_REAL` is missing. This variable points to the operator's JSON file
(schema in `test/support/smoke-real.ts`): `approval` (who approves which budget), `ledger`, and, for each `node`/`python`
entry, `config`, `data_dir`, `repo` and `run`. Each vendor lane has its own config and data dir, because role bindings are
global within one config. Requires `pnpm build`, the owner's harness record and the sandbox repo beforehand. Set `-t` to
select the exact scenario, since each suite may consume usage and open PRs.
