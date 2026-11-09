# Upgrading the user config: the workflow graph moves into code

From this version, the workflow graph (steps, `kind`, role, action, predicate, edges, outcome) is fixed in code:
[`src/engine/workflows/software-dev.ts`](../src/engine/workflows/software-dev.ts). The user config
(`~/.cusr/config.yaml`) no longer declares a graph; it only selects the built-in graph and tunes a few daemon parameters.

Previously the syntax allowed declaring the whole graph, but the daemon rejects every graph other than `software_dev@1`
when the policy is frozen. In practice, the only configs that run are those with `base: software_dev@1` plus step
parameters.

## Whether you need to edit your config

No, if every workflow only has `base: software_dev@1`, with or without `steps` where each step contains only the
parameters in the table below. The dogfood config (`impl: { base: software_dev@1 }`) falls into this case.

Edit it if `cusrd` fails to start or `cusr doctor` reports that the `config` check failed with an error like:

```text
config.yaml:52:15 workflow_key_removed: 'uses' can no longer be set: the software_dev@1 graph is fixed in code; remove workflows.impl.steps.code.uses (docs/config-upgrade.md)
```

## How to fix

1. For each `workflow_key_removed` error, delete the exact key named in the path (`workflows.<name>.…`).
2. A workflow without `base` (declaring `start` and all `steps`): replace it with `base: software_dev@1` and keep only the
   parameters in the table below. The graph it declared before could not run anyway, so no behavior is lost.
3. `unknown_step` error: the step is not in `software_dev@1`; delete the whole entry for that step.
4. `schema_invalid` error of the form `Step '<step>' does not take '<key>'; accepted: …`: that step does not accept this
   parameter; delete it or move it to a step that accepts it.
5. Run `cusr doctor`, then restart `cusrd`.

Before and after example:

```yaml
# Before
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { uses: [claude], max_visits: 10 }
      gates: { uses: [build] }
      review: { skip_when: { size: [XS, S] } }

# After
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { max_visits: 10 }
```

## Parameters that can still be set

`base: software_dev@1` is required. Each parameter below is read by the daemon; a step that is not in the table accepts
no parameters.

| Parameter | Steps that accept it | Where the daemon uses it |
|---|---|---|
| `max_visits` | Steps with a visit limit: `scout`, `code`, `gates`, `fix_gates`, `review`, `fix_review`, `publish`, `ci`, `ci_triage`, `rerun_ci`, `ci_autofix`, `ci_fix`, `merge` | Cap on visits to the step; when the visits run out, follow the graph's `on_exhausted` (usually `escalate`) |
| `max_rung` | Agent/review steps: `scout`, `code`, `fix_gates`, `review`, `fix_review`, `ci_fix` | Trims the role's escalation ladder when the policy is frozen |
| `run`, `required` | Gate steps: `gates`, `ci_autofix` | Names of the logical gates to run and the required gate; `required` must be listed in `run` |
| `poll`, `timeout` | CI wait step: `ci` | Poll interval and total wait for required checks |

Steps without a visit limit (`triage`, `prepare`, `pr`, `merge_gate`, `complete`) do not accept `max_visits`, so every
step that has a limit always has an `on_exhausted` target in the graph.

## Removed keys

| Key | Why it was removed |
|---|---|
| `start`, new step, `kind`, `action`, `for`, `rules`, `next`, `on_exhausted` | They are graph structure; any change is rejected via `structure_hash` |
| `role` | The daemon only runs the graph's fixed roles; changing a step's role makes preflight fail |
| `uses` | No step reads it at runtime |
| `when`, `skip_when`, `auto_when` | They change which steps run or skip the graph's review/merge approval; `full-review` and `direct-pr` decide review, and merge is decided by policy and yolo |
| `decisions` | Removed in issue 65; the decider answers worker questions enabled by `autonomous: true` at the root of the user config (issue 66), not per workflow |

## Existing tasks

The policy snapshot of a frozen task keeps the workflow it had then, including keys that can no longer be declared
(`uses`, `skip_when`, …). Existing tasks are still read, replayed, hash-verified and continue to run as before; there is
no migration, and events and snapshots are not edited. The `user` and `policy` hashes of new tasks do not change for
configs that use only the parameters in the table above.
