import type { CliCommand } from './program.ts';
import { renderReport } from './render.ts';
import { DATA_DIR, badFlag, query } from './tasks.ts';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DEFAULT_SINCE = '24h';

/** Whether the date part names a real day: `Date.parse` rolls 2026-02-30 over to March 2. */
function realDay(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

/**
 * `8h`, `2d`, `30m` back from `now`, epoch ms (the `until` of an earlier report), or an ISO date or time;
 * `null` when it is none of them or in the future. A date or time without an offset is local time: plain
 * `Date.parse` reads a bare date as UTC but a bare time as local.
 */
export function parseSince(text: string, now: number): number | null {
  const ago = /^(\d+)([mhd])$/.exec(text);
  const at = ago
    ? now - Number(ago[1]) * UNIT_MS[ago[2] as keyof typeof UNIT_MS]
    : /^\d+$/.test(text)
      ? Number(text)
      : realDay(text)
        ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00` : text)
        : Number.NaN;
  return Number.isFinite(at) && at >= 0 && at <= now ? at : null;
}

export const reportCommand: CliCommand = {
  name: 'report',
  description:
    'Report, per project, what finished, what waits for you and what the decider answered since a moment.',
  help: `Examples:
  cusr report
  cusr report --project acme --since 8h
  cusr report --since 2026-11-02T22:00
  cusr report --since 1762156800000
  cusr report --json

--since takes the until of an earlier report (epoch ms) to continue from it. A date or time without an
offset (Z, +07:00) is local time on this machine; a bare date is its local midnight.`,
  options: [
    DATA_DIR,
    { flags: '--project <id>', description: 'Only this project' },
    {
      flags: '--since <when>',
      description: `How far back: 30m, 8h, 2d, epoch ms, or an ISO date or time, local unless it has an offset (default: ${DEFAULT_SINCE})`,
    },
  ],
  run(values, json, io) {
    const { project } = values;
    if (project === '')
      return Promise.resolve(badFlag('--project must not be empty.', {}, json, io));
    const given = values['since'] ?? DEFAULT_SINCE;
    const since = parseSince(given, Date.now());
    if (since === null)
      return Promise.resolve(
        badFlag(
          `invalid --since ${JSON.stringify(given)}: use 30m, 8h, 2d, epoch ms, or an ISO date or time that is not in the future.`,
          {},
          json,
          io,
        ),
      );
    return query(
      values,
      { kind: 'report', since, ...(project === undefined ? {} : { project }) },
      json,
      io,
      undefined,
      renderReport,
    );
  },
};
