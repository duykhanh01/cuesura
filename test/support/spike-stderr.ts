import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Rejection = { readonly at: string; readonly line: string };
type RunEvidence = { readonly runtime_rejections: readonly Rejection[] };
type PermissionRuntime = {
  readonly runs: Record<string, RunEvidence>;
  readonly candidate_profile_runs: Record<string, RunEvidence>;
};

const EVIDENCE = fileURLToPath(
  new URL(
    '../fixtures/runtime/spike-0/harness/real-20261028/codex-permission-runtime.json',
    import.meta.url,
  ),
);

/**
 * Codex stderr of a real 2026-10-28 run, rebuilt from the `codex_core::tools::router` lines recorded
 * verbatim in codex-permission-runtime.json. The raw stderr.log captures were never committed (they
 * matched `*.log`) and are lost; their digests in manifest.json describe the originals, not this text.
 * Only the router lines survive, and they are the only stderr lines the stream summary reads.
 */
export function recordedCodexStderr(attempt: string): string {
  const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as PermissionRuntime;
  const run = evidence.runs[attempt] ?? evidence.candidate_profile_runs[attempt];
  if (run === undefined) throw new Error(`no recorded Codex stderr for ${attempt}`);
  return run.runtime_rejections.map((r) => `${r.at} ${r.line}\n`).join('');
}
