/**
 * Worker-prepared commit message and PR title/body (T136, task-execution-modes.md, M05/M07). The worker writes them as JSON to a file outside the worktree; the orchestrator checks
 * schema and size, refuses anything in the control-marker namespace `<!-- cusr:` (after the same
 * normalisation the PR parser uses) and stores the accepted content by digest, outside the code that
 * gets committed. It never reads Markdown headings or rewrites the text.
 */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { PublishContent } from './context.ts';

export const MAX_CONTENT_FILE_BYTES = 128 * 1024;

export const PublishContentSchema = z
  .object({
    commit_message: z
      .string()
      .min(1)
      .max(16 * 1024),
    pr_title: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n]+$/, 'single line'),
    pr_body: z.string().max(64 * 1024),
  })
  .strict();

// Zero-width and other format characters that would hide a marker from a naive search.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const ENTITY = /&(?:lt|#0*60|#x0*3c);?/gi;
const BANG = /&(?:excl|#0*33|#x0*21);?/gi;
const DASH = /&(?:#0*45|#x0*2d|hyphen|dash);?/gi;

/** Normalisation shared by the content check and the PR marker parser. */
export function normalizeForMarker(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ENTITY, '<')
    .replace(BANG, '!')
    .replace(DASH, '-')
    .toLowerCase();
}

const MARKER_NS = /<!--\s*cusr\s*:/g;

/** Number of control-marker openings in `text` after normalisation. */
export function markerCount(text: string): number {
  return normalizeForMarker(text).match(MARKER_NS)?.length ?? 0;
}

export type ContentProblem = {
  readonly field: string;
  readonly message: string;
};

/** Parses and checks the worker's file; a marker anywhere in any field refuses the whole content. */
export function validateContent(raw: string): Result<PublishContent, ContentProblem[]> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTENT_FILE_BYTES)
    return err([{ field: 'file', message: `larger than ${MAX_CONTENT_FILE_BYTES} bytes` }]);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err([{ field: 'file', message: 'not JSON' }]);
  }
  const parsed = PublishContentSchema.safeParse(json);
  if (!parsed.success)
    return err(
      parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'file',
        message: i.message,
      })),
    );
  const problems: ContentProblem[] = [];
  for (const field of ['commit_message', 'pr_title', 'pr_body'] as const) {
    if (markerCount(parsed.data[field]) > 0)
      problems.push({ field, message: 'contains a <!-- cusr: control marker' });
  }
  return problems.length > 0 ? err(problems) : ok(parsed.data);
}

/**
 * Reads the worker's content file without trusting what sits at `path`: the last component must not be
 * a symlink, the open never waits (a FIFO the worker made there cannot block the daemon) and only a
 * regular file within {@link MAX_CONTENT_FILE_BYTES} is read, never more than that many bytes plus one.
 * `ok(null)` means no file was written.
 */
export function readContentFile(path: string): Result<string | null, ContentProblem[]> {
  const bad = (message: string): Result<string | null, ContentProblem[]> =>
    err([{ field: 'file', message }]);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok(null);
    return bad(code === 'ELOOP' ? 'is a symlink' : `unreadable (${code ?? 'error'})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return bad('not a regular file');
    if (st.size > MAX_CONTENT_FILE_BYTES) return bad(`larger than ${MAX_CONTENT_FILE_BYTES} bytes`);
    const buf = Buffer.alloc(MAX_CONTENT_FILE_BYTES + 1);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off > MAX_CONTENT_FILE_BYTES) return bad(`larger than ${MAX_CONTENT_FILE_BYTES} bytes`);
    return ok(buf.subarray(0, off).toString('utf8'));
  } catch (e) {
    return bad(`unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  } finally {
    closeSync(fd);
  }
}

export function contentDigest(c: PublishContent): Hash {
  return hashCanonical(c);
}

/** Content the daemon stored at `ref` (a path it recorded), only if it still hashes to `digest`. */
export function readStoredContent(ref: string, digest: string): PublishContent | null {
  try {
    const c = PublishContentSchema.parse(JSON.parse(readFileSync(ref, 'utf8')));
    return contentDigest(c) === digest ? c : null;
  } catch {
    return null;
  }
}

/** Content stored by digest, write-once, outside any worktree. */
export class FileContentStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  put(c: PublishContent): { digest: Hash; ref: string } {
    const digest = contentDigest(c);
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const ref = join(this.#dir, `${digest.slice('sha256:'.length)}.json`);
    try {
      const fd = openSync(
        ref,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, JSON.stringify(c));
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    return { digest, ref };
  }

  /** The stored content, only if it still hashes to `digest`. */
  get(ref: string, digest: string): PublishContent | null {
    return readStoredContent(ref, digest);
  }
}
