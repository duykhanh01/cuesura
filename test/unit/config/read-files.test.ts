import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfigFiles } from '../../../src/config/read-files.ts';
import { CONFIGS } from '../../support/config-fixtures.ts';

describe('readConfigFiles', () => {
  it('đọc file người dùng và cusr.yaml, giữ đúng đường dẫn caller đưa vào', async () => {
    const user = join(CONFIGS, 'valid', 'user.yaml');
    const project = join(CONFIGS, 'valid', 'cusr.yaml');
    const files = await readConfigFiles({ user, project });
    expect(files.map((f) => f.file)).toEqual([user, project]);
    expect(files[1]?.text).toContain('extends: [node]');
  });

  it('không có cusr.yaml thì chỉ đọc file người dùng', async () => {
    expect(await readConfigFiles({ user: join(CONFIGS, 'valid', 'user.yaml') })).toHaveLength(1);
  });
});
