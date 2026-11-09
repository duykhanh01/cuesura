import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfigFiles } from '../../../src/config/read-files.ts';
import { CONFIGS } from '../../support/config-fixtures.ts';

describe('readConfigFiles', () => {
  it('reads user and project files while preserving caller-provided paths', async () => {
    const user = join(CONFIGS, 'valid', 'user.yaml');
    const project = join(CONFIGS, 'valid', 'cusr.yaml');
    const files = await readConfigFiles({ user, project });
    expect(files.map((f) => f.file)).toEqual([user, project]);
    expect(files[1]?.text).toContain('extends: [node]');
  });

  it('reads only the user file when cusr.yaml is absent', async () => {
    expect(await readConfigFiles({ user: join(CONFIGS, 'valid', 'user.yaml') })).toHaveLength(1);
  });
});
