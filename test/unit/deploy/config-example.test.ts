import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../../../src/daemon/main.ts';

// The sample config the daemon_unreachable guidance points to must start cusrd as written.
const SAMPLE = fileURLToPath(new URL('../../../deploy/config.example.yaml', import.meta.url));

describe('deploy/config.example.yaml', () => {
  it('is a config cusrd accepts, without warnings', async () => {
    const r = await loadDaemonConfig({ config: SAMPLE, dataDir: '/tmp/cusr-sample' });
    expect(r).toMatchObject({ ok: true, value: { dataDir: '/tmp/cusr-sample', warnings: [] } });
  });
});
