/** The registered assistant session on disk; the Stop hook reads it on every Stop, so it imports nothing heavy. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Names the session a Stop hook may wake (cusr assistant register). Unlike the lease it survives a restart,
 * because that hook only starts on the session's next Stop and nothing else would claim the lease back.
 */
export const ASSISTANT_SESSION_FILE = 'assistant-session.json';

/** Only the daemon writes this file, so no other process can lose a change it made. */
type SessionFile = {
  readonly session: string | null;
  readonly replaced: readonly string[];
  /** The attention desk's confirmed mark for ended tasks (#257). */
  readonly ended_after: number | null;
};

export function readSessionFile(dataDir: string): SessionFile {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, ASSISTANT_SESSION_FILE), 'utf8')) as Record<
      string,
      unknown
    > | null;
    const session = raw?.['session'];
    const replaced = raw?.['replaced'];
    const endedAfter = raw?.['ended_after'];
    return {
      session: typeof session === 'string' ? session : null,
      replaced: Array.isArray(replaced)
        ? replaced.filter((r): r is string => typeof r === 'string')
        : [],
      ended_after: Number.isSafeInteger(endedAfter) ? (endedAfter as number) : null,
    };
  } catch {
    return { session: null, replaced: [], ended_after: null };
  }
}

export function registeredSession(dataDir: string): string | null {
  return readSessionFile(dataDir).session;
}

/**
 * Registered sessions another one took the lease from and that were not told yet. Kept on disk because
 * such a session may have no hook parked when it happens: its next Stop must still be able to say so.
 */
export function replacedSessions(dataDir: string): readonly string[] {
  return readSessionFile(dataDir).replaced;
}
