import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loginExpiry } from '../../../src/application/doctor.ts';
import { tempDir } from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor reads only the login expiry of a credential (#97)', () => {
  const file = (content: string): string => {
    const f = join(tempDir('cusr-doctor-', dirs), 'credentials.json');
    writeFileSync(f, content);
    return f;
  };

  it('takes the refresh-token expiry of an OAuth login', () => {
    expect(
      loginExpiry(
        file(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: 'secret',
              refreshToken: 'secret',
              expiresAt: 5,
              refreshTokenExpiresAt: 1_000,
            },
          }),
        ),
      ),
    ).toBe(1_000);
  });

  it.each([
    ['a login without an expiry', JSON.stringify({ tokens: { a: 'x' } })],
    ['not JSON', 'sk-plain-key'],
    ['a JSON array', '[]'],
  ])('has no expiry for %s', (_n, content) => {
    expect(loginExpiry(file(content))).toBeNull();
  });

  it('has no expiry for a missing file', () => {
    expect(loginExpiry('/nonexistent/credentials.json')).toBeNull();
  });
});
