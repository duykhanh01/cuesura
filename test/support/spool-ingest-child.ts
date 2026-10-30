/**
 * Child process for spool crash tests, run as `node test/support/spool-ingest-child.ts <args.json>`.
 * Opens the file store (which reads `CUSR_CRASH_AT`/`CUSR_CRASH_AFTER`), runs one spool ingest pass
 * for an operation and prints the report. The crash hook SIGKILLs this process at the chosen point.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { ingestOperationSpool } from '../../src/daemon/ingest.ts';
import { STORE_FILE } from '../../src/daemon/main.ts';
import type { FileLimits } from '../../src/runner/files.ts';
import { Redactor } from '../../src/runner/redact.ts';
import { openStore } from '../../src/store/index.ts';

export type SpoolChildArgs = {
  readonly data_dir: string;
  readonly task_id: string;
  readonly operation_id: string;
  readonly limits: FileLimits;
  readonly now: number;
  readonly batch_records: number;
};

const file = process.argv[2];
if (file === undefined) throw new Error('missing args file');
const args = JSON.parse(readFileSync(file, 'utf8')) as SpoolChildArgs;
const opened = openStore(join(args.data_dir, STORE_FILE));
if (!opened.ok) {
  process.stdout.write(`open_failed ${opened.error.code}\n`);
  process.exit(3);
}
const report = ingestOperationSpool(
  {
    store: opened.value,
    dataDir: args.data_dir,
    redactor: new Redactor(),
    limits: args.limits,
    now: () => args.now,
    newId: uuidv7,
    batchRecords: args.batch_records,
  },
  args.task_id,
  args.operation_id,
);
opened.value.close();
process.stdout.write(`${JSON.stringify(report)}\n`);
