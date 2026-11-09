/**
 * Artifact index of one run directory (T074, FR-016, contracts/execution.md). Lists
 * the files the orchestrator ingests (event segments, stderr, exit, result) with digest, size and
 * redaction version. A path is accepted only inside the run directory, as a regular file reached
 * without a symlink, within its cap; anything else is a problem, never silently skipped or truncated.
 *
 * `finalized` means the operation's exit.json is complete; `acked` stays false here: an artifact is
 * acknowledged only once the store committed it (`ArtifactIngested`), which retention checks.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Artifact, ArtifactKind } from '../domain/runtime.ts';
import type { Hash } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { listSegments, RUN_FILES, RunnerFileError, SPOOL_DIR, type RunDir } from './files.ts';
import { RunnerExitSchema } from './lifecycle.ts';

export type ArtifactProblem = {
  readonly path: string;
  readonly reason: 'symlink' | 'not_regular_file' | 'unsafe_path' | 'oversize' | 'unreadable';
  readonly detail: string;
};

type Candidate = {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly cap: number;
};

/** Deterministic, so a repeated ingest of the same file is the same artifact. */
export function artifactId(operationId: string, path: string): string {
  return `${operationId}:${path}`;
}

function digestFile(
  run: RunDir,
  rel: string,
  cap: number,
): Result<{ digest: Hash; bytes: number } | null, ArtifactProblem> {
  let path: string;
  try {
    path = run.resolve(rel);
  } catch (e) {
    const code = e instanceof RunnerFileError ? e.code : 'unsafe_path';
    return err({
      path: rel,
      reason: code === 'symlink' ? 'symlink' : 'unsafe_path',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok(null);
    return err({
      path: rel,
      reason: code === 'ELOOP' ? 'symlink' : 'unreadable',
      detail: String(code),
    });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      return err({
        path: rel,
        reason: 'not_regular_file',
        detail: 'not a regular file',
      });
    if (st.size > cap)
      return err({
        path: rel,
        reason: 'oversize',
        detail: `${st.size} bytes, cap ${cap}`,
      });
    const h = createHash('sha256');
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      total += n;
      if (total > cap)
        return err({
          path: rel,
          reason: 'oversize',
          detail: `grew past cap ${cap}`,
        });
    }
    return ok({ digest: `sha256:${h.digest('hex')}`, bytes: total });
  } finally {
    closeSync(fd);
  }
}

/** Every artifact currently in the run directory, or every problem found. */
export function collectArtifacts(
  run: RunDir,
  operationId: string,
): Result<Artifact[], ArtifactProblem[]> {
  const limits = run.limits;
  const candidates: Candidate[] = [
    ...listSegments(run).map((s) => ({
      path: `${SPOOL_DIR}/${s.name}`,
      kind: 'events' as const,
      cap: limits.log_segment_bytes + limits.log_record_bytes,
    })),
    { path: RUN_FILES.stderr, kind: 'stderr', cap: limits.spool_bytes },
    { path: RUN_FILES.exit, kind: 'exit', cap: limits.result_bytes },
    { path: RUN_FILES.result, kind: 'result', cap: limits.result_bytes },
  ];
  const finalized = run.readFinal(RUN_FILES.exit, RunnerExitSchema).state === 'valid';
  const out: Artifact[] = [];
  const problems: ArtifactProblem[] = [];
  for (const c of candidates) {
    const d = digestFile(run, c.path, c.cap);
    if (!d.ok) {
      problems.push(d.error);
      continue;
    }
    if (d.value === null) continue;
    out.push({
      artifact_id: artifactId(operationId, c.path),
      operation_id: operationId,
      kind: c.kind,
      relative_path: c.path,
      digest: d.value.digest,
      bytes: d.value.bytes,
      redaction_version: run.redactor.version,
      finalized,
      acked: false,
    });
  }
  return problems.length > 0 ? err(problems) : ok(out);
}
