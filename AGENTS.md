# Agent rules

These rules applied to every agent working in this repository (Claude Code, Codex, ...). `CLAUDE.md` points
here. The project is archived; the rules are kept as an example of how the agents were guided.

**Workers launched by Cuesura:** follow the role prompt and skip the worktree, commit, push and PR sections
below; the daemon handles those. Do not call `cusr`.

## Code comments

Applies to workers launched by Cuesura as well.

- Comment only when needed: a reason, a constraint or a behavior that reading the code does not show. Do not
  repeat what the code already says.
- Write comments in English.

## One worktree per change, then a PR

- Make every change (code, tests, docs) in its own git worktree created from the latest `origin/main`. Do not
  edit `main` directly and do not work in the main worktree of the repository.

  ```sh
  git fetch origin
  git worktree add ../cuesura.worktrees/<branch> -b <branch> origin/main
  cd ../cuesura.worktrees/<branch> && pnpm install
  ```

- Branch names follow the scope of the work: `<feature>/<description>` (for example `002/preflight`),
  `fix/<description>`, `docs/<description>`.
- Work that needs code from an unmerged PR: ask the user first; do not branch from an unmerged branch.
- Checks that match the change:
  - Docs only: run `git diff --check` on the working diff and on the PR diff, check internal links and
    consistency, and review Markdown headings, tables and code fences by hand. `.oxfmtrc.jsonc` ignores Markdown,
    so `pnpm format:check`/Oxfmt is not evidence of docs formatting. Do not run `pnpm typecheck`, `pnpm lint`,
    `pnpm test` or `pnpm build` only because docs changed. CI also skips `build` and `test` when a PR changes
    only Markdown files outside `src/` and `test/`.
  - Code, tests or executable configuration: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
    `pnpm test:changed` must be clean; also run the checks required by the scope of the change and the repository
    guides. `pnpm lint` runs ESLint and `pnpm format:check` runs `oxfmt --check`; fix formatting with
    `pnpm format`.
  - `pnpm test:changed` runs only the tests that depend on files changed against `origin/main` (including
    uncommitted changes); while editing, run the relevant test file directly with `pnpm vitest run <file>`.
    Do not run the full `pnpm test` locally: CI runs it for every PR. The full CI run must be green before the
    user merges; if CI is red, fix and push again, and note tests already broken on `main` in the PR.
- A PR that changes the check rules is still held to the rules on `main` until it merges, unless the user says
  otherwise; do not use the new rules in a PR to exempt that same PR.
- When done: commit, push the branch and open a PR into `main`. Agents never merge PRs; the user merges.
  Write the PR description following the [PR template](.github/pull_request_template.md) and the `write-pr`
  skill ([src/assets/write-pr/SKILL.md](src/assets/write-pr/SKILL.md)); `gh pr create --body` does not apply
  the template, so follow it by hand.
