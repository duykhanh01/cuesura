import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  REDACTION_VERSION,
  Redactor,
  isSecretName,
  secretValuesFromEnv,
  secretValuesFromText,
} from '../../../src/runner/redact.ts';

describe('Redactor', () => {
  it('replaces literal secret values in text and exposes the redaction version', () => {
    const r = new Redactor({ values: ['s3cr3t-value-xyz'] });
    expect(r.version).toBe(REDACTION_VERSION);
    expect(r.text('token=s3cr3t-value-xyz; again s3cr3t-value-xyz')).toBe(
      `token=${REDACTED}; again ${REDACTED}`,
    );
  });

  it('collects values from secret-named env entries only', () => {
    const env = {
      GH_TOKEN: 'gh-value-123456',
      OPENAI_API_KEY: 'openai-value-1',
      DB_PASSWORD: 'hunter22',
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
    };
    expect(secretValuesFromEnv(env).sort()).toEqual([
      'gh-value-123456',
      'hunter22',
      'openai-value-1',
    ]);
    const r = new Redactor({ env });
    expect(r.text('gh-value-123456 openai-value-1 hunter22 /usr/bin:/bin')).toBe(
      `${REDACTED} ${REDACTED} ${REDACTED} /usr/bin:/bin`,
    );
  });

  it.each([
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'MY_KEY',
    'password',
    'client_secret',
    'apiKey',
    'accessToken',
    'SSH_PRIVATE_KEY',
    'authorization',
  ])('treats %s as a secret name', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'input_tokens', 'monkey', 'key_count', 'tokenizer'])(
    'does not treat %s as a secret name',
    (name) => {
      expect(isSecretName(name)).toBe(false);
    },
  );

  it('redacts nested JSON by value, by pattern and by secret-named key', () => {
    const r = new Redactor({ values: ['literal-secret-1'] });
    const out = r.value({
      argv: ['--auth', 'literal-secret-1'],
      env: { GITHUB_TOKEN: 'short', PATH: '/bin' },
      nested: [{ msg: 'Authorization: Bearer abc.def.ghi' }, { gh: `ghp_${'a'.repeat(36)}` }],
      usage: { input_tokens: 12 },
      'literal-secret-1': true,
    });
    expect(out).toEqual({
      argv: ['--auth', REDACTED],
      env: { GITHUB_TOKEN: REDACTED, PATH: '/bin' },
      nested: [{ msg: `Authorization: ${REDACTED}` }, { gh: REDACTED }],
      usage: { input_tokens: 12 },
      [REDACTED]: true,
    });
  });

  it('redacts a secret even when it would be JSON-escaped on disk', () => {
    const secret = 'pa"ss\\word-123';
    const r = new Redactor({ values: [secret] });
    const line = JSON.stringify(r.value({ s: `x ${secret} y` }));
    expect(line).not.toContain('pa\\"ss');
    expect(line).toContain(REDACTED);
  });

  it('replaces the longest overlapping value first', () => {
    const r = new Redactor({ values: ['abcdef', 'abcdefghij'] });
    expect(r.text('abcdefghij')).toBe(REDACTED);
  });

  it('ignores literal values shorter than the minimum length', () => {
    const r = new Redactor({ values: ['abc'] });
    expect(r.text('abc abc')).toBe('abc abc');
  });

  it('matches well-known credential shapes without being told the value', () => {
    const r = new Redactor();
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
    expect(r.text(`a ${key} b`)).toBe(`a ${REDACTED} b`);
    expect(r.text('AKIAABCDEFGHIJKLMNOP')).toBe(REDACTED);
    expect(r.text('"password": "correct-horse"')).toBe(`"password": "${REDACTED}"`);
  });

  it('rejects values that are not JSON-serializable', () => {
    expect(() => new Redactor().value(undefined)).toThrow(TypeError);
    expect(() => new Redactor().value({ n: 1n })).toThrow(TypeError);
  });

  it.each(['?', '?ref=main&'])(
    'redacts URL tokens after %s in text and JSON without consuming other URL parts',
    (query) => {
      const r = new Redactor();
      const base = `https://raw.githubusercontent.com/example/private/main/file.txt${query}token=`;
      const token = 'test-only-download-token';
      const url = `${base}${token}&raw=1#section`;
      const expected = `${base}${REDACTED}&raw=1#section`;
      expect(r.text(`Download '${url}' now`)).toBe(`Download '${expected}' now`);
      expect(r.text(JSON.stringify({ download_url: url }))).toBe(
        JSON.stringify({ download_url: expected }),
      );
      expect(r.value({ download_url: url })).toEqual({
        download_url: expected,
      });
      expect(r.text(expected)).toBe(expected);
    },
  );
});

describe('secretValuesFromText', () => {
  it('takes long JSON string leaves from an auth file', () => {
    const text = JSON.stringify({
      tokens: { access_token: 'access-0123456789', id: 'short' },
      list: ['refresh-0123456789'],
    });
    expect(secretValuesFromText(text).sort()).toEqual(['access-0123456789', 'refresh-0123456789']);
  });

  it('falls back to lines and KEY=value right-hand sides', () => {
    expect(secretValuesFromText('API_KEY=abcdefghijklmnop\nx=1\n')).toEqual([
      'API_KEY=abcdefghijklmnop',
      'abcdefghijklmnop',
    ]);
  });
});
