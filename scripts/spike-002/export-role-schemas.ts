/**
 * Exports the spike 0 role JSON Schemas and their digests (T003).
 *
 *   node scripts/spike-002/export-role-schemas.ts [--out DIR]          write files
 *   node scripts/spike-002/export-role-schemas.ts [--out DIR] --check  exit 1 on drift
 *
 * Digest = sha256 of the canonical JSON of the schema (src/shared/hash.ts), not of file bytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_SCHEMAS, ROLES, roleJsonSchema, roleSchemaDigest } from './role-schema.ts';

export const DEFAULT_SCHEMA_DIR = fileURLToPath(new URL('../../test/fixtures/runtime/spike-0/schema/', import.meta.url));

export type ExportedFile = { readonly name: string; readonly content: string };

function fileName(schemaId: string): string {
  return `${schemaId}.schema.json`;
}

/** Deterministic file set: one file per schema id plus manifest.json mapping role → schema/digest. */
export function renderSchemaFiles(): ExportedFile[] {
  const files = new Map<string, string>();
  const roles: Record<string, { schema_id: string; file: string; digest: string }> = {};
  for (const role of ROLES) {
    const id = ROLE_SCHEMAS[role].id;
    files.set(fileName(id), `${JSON.stringify(roleJsonSchema(role), null, 2)}\n`);
    roles[role] = { schema_id: id, file: fileName(id), digest: roleSchemaDigest(role) };
  }
  const manifest = {
    schema_version: 1,
    source: 'scripts/spike-002/role-schema.ts',
    spec: 'SPEC.md §12.3',
    digest_algorithm: 'sha256 over canonical JSON (src/shared/hash.ts hashCanonical)',
    harness_acceptance: 'unproven: S0.2 (T007) must record per role × vendor acceptance',
    roles,
  };
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return [...files].map(([name, content]) => ({ name, content }));
}

export function checkSchemaFiles(dir: string): string[] {
  const drift: string[] = [];
  for (const f of renderSchemaFiles()) {
    let current: string | null;
    try {
      current = readFileSync(join(dir, f.name), 'utf8');
    } catch {
      current = null;
    }
    if (current !== f.content) drift.push(f.name);
  }
  return drift;
}

function main(argv: readonly string[]): number {
  let out = DEFAULT_SCHEMA_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--out' && argv[i + 1] !== undefined) out = resolve(argv[++i] as string);
    else {
      process.stderr.write('usage: export-role-schemas.ts [--out DIR] [--check]\n');
      return 2;
    }
  }
  if (check) {
    const drift = checkSchemaFiles(out);
    process.stdout.write(`${JSON.stringify({ ok: drift.length === 0, dir: out, drift })}\n`);
    return drift.length === 0 ? 0 : 1;
  }
  mkdirSync(out, { recursive: true });
  for (const f of renderSchemaFiles()) writeFileSync(join(out, f.name), f.content);
  process.stdout.write(`${JSON.stringify({ ok: true, dir: out, files: renderSchemaFiles().map((f) => f.name) })}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
