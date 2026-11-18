import { describe, expect, it } from 'vitest';
import { deputyCheck } from '../../../src/application/doctor.ts';
import { ROLE_SCHEMA_DIGESTS } from '../../../src/adapters/harness/result-schema.ts';

describe('doctor names the command that adds deputy evidence (#316)', () => {
  const user = {
    roles: { deputy: { binding: [{ model: 'opus' }] } },
    models: { opus: { harness: 'claude', id: 'claude-opus-5-5' } },
  } as never;
  const manifest = (roles: Record<string, string>, refs: string[] = []) =>
    ({ claude: { role_schemas: roles, fixture_refs: refs } }) as never;
  const paths = { config: "/home/o w/it's.yaml", dataDir: '/srv/cusr data' };

  it('points a manifest without the deputy role at this installation and its last evidence', () => {
    const c = deputyCheck(
      user,
      manifest({ coder: ROLE_SCHEMA_DIGESTS.coder }, ['/proofs/evidence claude.json']),
      new Set(),
      paths,
    );
    expect(c.status).toBe('fail');
    // The command is a line of its own, so nothing after it joins the last argument.
    expect(c.fix?.split('\n')[0]).toBe(
      `cusr-runner setup-harness --from prove-harness --config '/home/o w/it'\\''s.yaml' --data-dir '/srv/cusr data' --harness claude --model claude-opus-5-5 --out '/proofs/evidence claude.json'`,
    );
    expect(c.fix).toContain('restart cusrd');
  });

  it('asks for the evidence file when the manifest does not name it absolutely', () => {
    const c = deputyCheck(user, manifest({}, ['evidence.json']), new Set(), paths);
    expect(c.fix).toContain('--out <evidence file of its last proof>');
  });

  it('does not offer a proof-only command when the harness has no manifest', () => {
    const c = deputyCheck(user, { claude: null }, new Set(), paths);
    expect(c.fix).not.toContain('--from prove-harness');
    expect(c.fix).toContain("--data-dir '/srv/cusr data'");
  });

  it('asks for a restart when the disk already changed', () => {
    expect(deputyCheck(user, manifest({}), new Set(['claude']), paths).fix).toContain('restart');
  });

  it('passes once the manifest proves the current deputy schema', () => {
    expect(deputyCheck(user, manifest({ deputy: ROLE_SCHEMA_DIGESTS.deputy })).status).toBe('ok');
  });
});
