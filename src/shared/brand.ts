import { z } from 'zod';

export type Uuid = string & { readonly __brand: 'Uuid' };
export type EpochMs = number & { readonly __brand: 'EpochMs' };
export type Hash = `sha256:${string}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export const UuidSchema = z
  .string()
  .regex(UUID_RE, 'Invalid UUID')
  .transform((s) => s as Uuid);

export const EpochMsSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => n as EpochMs);

export const HashSchema = z
  .string()
  .regex(HASH_RE, 'Hash must have the format sha256:<64 hexadecimal characters>')
  .transform((s) => s as Hash);

export function asUuid(s: string): Uuid {
  return UuidSchema.parse(s);
}

export function asEpochMs(n: number): EpochMs {
  return EpochMsSchema.parse(n);
}
