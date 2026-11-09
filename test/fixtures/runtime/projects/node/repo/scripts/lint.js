import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const bad = [];
for (const dir of ['src', 'test'])
  for (const name of readdirSync(dir)) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\s$/.test(line)) bad.push(`${dir}/${name}:${i + 1}: trailing whitespace`);
    });
  }
for (const b of bad) console.error(b);
process.exitCode = bad.length === 0 ? 0 : 1;
