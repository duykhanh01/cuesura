/**
 * What the runner shows when its stdout is a multiplexer's terminal (ADR-0006). The event log stays the only
 * record; this is a view of it. A terminal that stalls or goes away must never hold the runner up: the descriptor is
 * non-blocking, a line that does not fit is dropped, and a dead terminal turns the echo off.
 */
import { closeSync, constants, openSync, writeSync } from 'node:fs';

const LINE_CHARS = 2_000;

function clean(text: string): string {
  // Agent output must not reach the terminal as escape sequences.
  // eslint-disable-next-line no-control-regex
  const safe = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return safe.length > LINE_CHARS ? `${safe.slice(0, LINE_CHARS)}…` : safe;
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function claudeBlocks(message: unknown): string[] {
  const content = record(message)?.['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b): string[] => {
    const block = record(b);
    if (block?.['type'] === 'text') return [str(block['text']) ?? ''];
    if (block?.['type'] === 'tool_use')
      return [`▸ ${str(block['name']) ?? 'tool'} ${JSON.stringify(block['input'] ?? {})}`];
    return [];
  });
}

function codexItem(item: unknown): string[] {
  const i = record(item);
  if (i?.['type'] === 'agent_message') return [str(i['text']) ?? ''];
  if (i?.['type'] === 'command_execution') return [`▸ ${str(i['command']) ?? 'command'}`];
  return [];
}

/** Best effort per harness: an event it does not know is simply not shown, and stays in the log. */
export function formatRecord(data: unknown): string | null {
  const r = record(data);
  if (r === null) return null;
  const lines =
    r['type'] === 'assistant'
      ? claudeBlocks(r['message'])
      : r['type'] === 'item.completed'
        ? codexItem(r['item'])
        : r['type'] === undefined && typeof r['text'] === 'string'
          ? [r['text']]
          : [];
  const text = lines.map(clean).filter((l) => l !== '');
  return text.length === 0 ? null : `${text.join('\n')}\n`;
}

export type TerminalEcho = {
  write(text: string): void;
};

/** `write` throws what `writeSync` throws; injected so a test can stall or kill the terminal. */
export function terminalEcho(
  write: (text: string) => void,
  onClose: () => void = () => undefined,
): TerminalEcho {
  let open = true;
  return {
    write(text) {
      if (!open) return;
      try {
        write(text);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return;
        open = false;
        onClose();
      }
    },
  };
}

/** A second, non-blocking description of stdout; null when it cannot be opened. */
export function openStdoutEcho(): TerminalEcho | null {
  try {
    const fd = openSync(
      '/proc/self/fd/1',
      constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
    );
    return terminalEcho(
      (text) => void writeSync(fd, text),
      () => {
        try {
          closeSync(fd);
        } catch {
          // Already gone with the terminal.
        }
      },
    );
  } catch {
    return null;
  }
}

/**
 * Ctrl-C in the pane and the pane closing are not a stop request. Node resets inherited dispositions, so
 * the `trap` of the unit does not cover the runner: only systemd's SIGTERM stops the operation.
 */
export function terminalStop(stop: () => void): () => void {
  const ignore = (): void => undefined;
  process.on('SIGTERM', stop);
  process.on('SIGINT', ignore);
  process.on('SIGHUP', ignore);
  return () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', ignore);
    process.off('SIGHUP', ignore);
  };
}
