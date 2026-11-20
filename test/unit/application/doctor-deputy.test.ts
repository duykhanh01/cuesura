import { describe, expect, it } from 'vitest';
import { deputyCheck } from '../../../src/application/doctor.ts';
import { ROLE_SCHEMA_DIGESTS } from '../../../src/adapters/harness/result-schema.ts';

describe('doctor names the command that adds the deputy role (#316)', () => {
  const user = {
    roles: { deputy: { binding: [{ model: 'opus' }] } },
    models: { opus: { harness: 'claude', id: 'claude-opus-5-5' } },
  } as never;
  const manifest = (roles: Record<string, string>) =>
    ({ claude: { role_schemas: roles, fixture_refs: [] } }) as never;
  const paths = { config: "/home/o w/it's.yaml", dataDir: '/srv/cusr data' };

  it('records the manifest again for this installation, without a model', () => {
    const c = deputyCheck(user, manifest({ coder: ROLE_SCHEMA_DIGESTS.coder }), new Set(), paths);
    expect(c.status).toBe('fail');
    // The command is a line of its own, so nothing after it joins the last argument.
    expect(c.fix?.split('\n')[0]).toBe(
      `cusr-runner setup-harness --from record-manifest --config '/home/o w/it'\\''s.yaml' --data-dir '/srv/cusr data' --harness claude`,
    );
    expect(c.fix).toContain('restart cusrd');
    expect(c.fix).not.toContain('--model');
  });

  it('asks for the pin flags when the harness has no manifest', () => {
    const c = deputyCheck(user, { claude: null }, new Set(), paths);
    expect(c.fix).not.toContain('--from');
    expect(c.fix).toContain("--data-dir '/srv/cusr data'");
  });

  it('asks for a restart when the disk already changed', () => {
    expect(deputyCheck(user, manifest({}), new Set(['claude']), paths).fix).toContain('restart');
  });

  it('passes once the manifest covers the current deputy schema', () => {
    expect(deputyCheck(user, manifest({ deputy: ROLE_SCHEMA_DIGESTS.deputy })).status).toBe('ok');
  });
});
