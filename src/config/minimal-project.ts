/** The smallest `cusr.yaml` a task can start with; `profile` must name a profile of the user config. */
export const MINIMAL_PROJECT_CONFIG = `version: 1
profile: default            # a profile declared in the user config
gates:                      # software_dev@1 requires build and unit
  build: "pnpm build"
  unit: "pnpm test"
ci:
  required_checks: [build]  # CI checks a PR must pass on GitHub
`;

/** The same config on one line, for an error's fix. */
export const MINIMAL_PROJECT_CONFIG_LINE =
  '{ version: 1, profile: default, gates: { build: "pnpm build", unit: "pnpm test" }, ci: { required_checks: [build] } }';

/** The sample indented for a help text. */
export const MINIMAL_PROJECT_CONFIG_HELP = MINIMAL_PROJECT_CONFIG.trimEnd()
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n');
