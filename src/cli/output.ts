export const CONTROL_SOCKET = 'control.sock';

export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  connection: 3,
  missing: 4,
  forbidden: 5,
  conflict: 6,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface EnvelopeError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly request_id: string | null;
}

export type Envelope<T = unknown> =
  | {
      readonly schema_version: 1;
      readonly ok: true;
      readonly data: T;
      readonly error: null;
    }
  | {
      readonly schema_version: 1;
      readonly ok: false;
      readonly data: null;
      readonly error: EnvelopeError;
    };

export function okEnvelope<T>(data: T): Envelope<T> {
  return { schema_version: 1, ok: true, data, error: null };
}

export function errorEnvelope(error: EnvelopeError): Envelope<never> {
  return { schema_version: 1, ok: false, data: null, error };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The full shape, both branches, so a caller may touch `error.code` once this says yes. */
export function isEnvelope(v: unknown): v is Envelope {
  if (!isRecord(v) || v['schema_version'] !== 1) return false;
  if (v['ok'] === true) return 'data' in v;
  if (v['ok'] !== false) return false;
  const e = v['error'];
  return (
    isRecord(e) &&
    typeof e['code'] === 'string' &&
    typeof e['message'] === 'string' &&
    isRecord(e['details']) &&
    (e['request_id'] === null || typeof e['request_id'] === 'string')
  );
}

/** One JSON object per line; finite output is exactly one such line. */
export function renderEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}
