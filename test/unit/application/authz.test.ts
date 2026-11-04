import { describe, expect, it } from 'vitest';
import { authorize, authzContext, callerFor } from '../../../src/application/authz.ts';

describe('declared caller', () => {
  it('is the owner when nothing is declared', () => {
    for (const declared of [undefined, null, '', 'owner'])
      expect(callerFor(declared)?.grant).toEqual({
        actor: 'owner',
        roles: ['read', 'operate', 'admin'],
      });
  });

  it('holds an assistant to read and operate', () => {
    const caller = callerFor('assistant');
    expect(caller?.grant).toEqual({ actor: 'assistant', roles: ['read', 'operate'] });
    expect(authzContext(caller as NonNullable<typeof caller>, 5)).toEqual({
      actor: 'assistant',
      roles: ['read', 'operate'],
      issued_by: 'socket:assistant',
      issued_at: 5,
    });
  });

  it('refuses a name that is not a known actor', () => {
    expect(callerFor('viewer')).toBeNull();
    expect(callerFor('Owner')).toBeNull();
  });
});

describe('server-side authorization', () => {
  it('an assistant may operate but never admin', () => {
    const a = callerFor('assistant');
    expect(authorize(a, { role: 'operate' })).toEqual({ ok: true });
    expect(authorize(a, { role: 'admin' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role', required: 'admin' },
    });
    expect(authorize(callerFor('owner'), { role: 'admin' })).toEqual({ ok: true });
  });

  it('no caller is unauthenticated', () => {
    expect(authorize(null, { role: 'read' })).toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
  });
});
