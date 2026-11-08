import { describe, expect, it } from 'vitest';
import {
  DeclaredScopeSchema,
  effectiveScope,
  normalizeScopeEntry,
  scopeOverlap,
  slotBlock,
} from '../../../src/application/scope-match.ts';

describe('declared scope (issue #240)', () => {
  it('normalizes entries and refuses paths that leave the repository', () => {
    expect(normalizeScopeEntry('./src/engine/')).toBe('src/engine');
    expect(normalizeScopeEntry('src\\a.ts')).toBe('src/a.ts');
    expect(normalizeScopeEntry('/etc/passwd')).toBeNull();
    expect(normalizeScopeEntry('src/../x')).toBeNull();
    expect(normalizeScopeEntry('C:/x')).toBeNull();
    expect(normalizeScopeEntry('.')).toBeNull();
    expect(DeclaredScopeSchema.parse(['b.ts', './a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
    expect(DeclaredScopeSchema.safeParse(['../x']).success).toBe(false);
  });

  it('refuses glob syntax it cannot compare safely, and keeps such characters in plain names', () => {
    for (const e of ['@(src|lib)/**', 'src/{a/b,c/d}/*.ts', '!src/**', 'src/+(a|b)', 'src/[a/b]'])
      expect(normalizeScopeEntry(e)).toBeNull();
    for (const e of ['packages/@acme/x', 'app/(group)/page.tsx', 'c++/a.cc', 'app/[id]/page.tsx'])
      expect(normalizeScopeEntry(e)).toBe(e);
  });

  it('matches a literal name that also reads as a glob', () => {
    expect(scopeOverlap(['app/[id]/page.tsx'], ['app/[id]/page.tsx'])).toEqual([
      'app/[id]/page.tsx',
    ]);
    expect(scopeOverlap(['app/[id]'], ['app/[id]/page.tsx'])).toEqual(['app/[id]/page.tsx']);
    expect(scopeOverlap(['src/**/*.ts'], ['src/**'])).toEqual(['src/**']);
  });

  it('matches paths, directories and globs against each other', () => {
    expect(scopeOverlap(['src/a.ts'], ['src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts']);
    expect(scopeOverlap(['src/engine'], ['src/engine/runtime.ts'])).toEqual([
      'src/engine/runtime.ts',
    ]);
    expect(scopeOverlap(['src/engine/runtime.ts'], ['src/engine'])).toEqual([
      'src/engine/runtime.ts',
    ]);
    expect(scopeOverlap(['src/engine/**'], ['src/engine/runtime.ts'])).toEqual([
      'src/engine/runtime.ts',
    ]);
    expect(scopeOverlap(['*.md'], ['README.md', 'docs/x.md'])).toEqual(['README.md']);
    expect(scopeOverlap(['src/*/x.ts'], ['src/a'])).toEqual(['src/a']);
    expect(scopeOverlap(['src/**'], ['src/engine/*.ts'])).toEqual(['src/engine/*.ts']);
    expect(scopeOverlap(['src/a/*.ts'], ['src/b/*.ts'])).toEqual([]);
    expect(scopeOverlap(['src/a.ts'], ['src/ab.ts'])).toEqual([]);
    expect(scopeOverlap(null, ['src/a.ts'])).toEqual([]);
    expect(scopeOverlap(['src/a.ts'], [])).toEqual([]);
  });

  it('unions changed and declared files; neither is unknown', () => {
    expect(effectiveScope(null, undefined)).toBeNull();
    expect(effectiveScope([], undefined)).toEqual([]);
    expect(effectiveScope(['b.ts'], ['a/**'])).toEqual(['a/**', 'b.ts']);
    expect(effectiveScope(null, ['a/**'])).toEqual(['a/**']);
  });

  it('blocks a candidate only on holders that share a file with it', () => {
    const at = (files: string[] | null, project = 'acme') => ({ project, files });
    const scopes = new Map([
      ['c', at(['src/engine/**'])],
      ['h1', at(['src/engine/runtime.ts'])],
      ['h2', at(['docs/x.md'])],
      ['h3', at(null)],
      ['other', at(['src/engine/runtime.ts'], 'elsewhere')],
    ]);
    expect(slotBlock('c', scopes, ['h1', 'h2', 'h3'])).toEqual({
      code: 'scope_overlap',
      tasks: [{ task_id: 'h1', files: ['src/engine/runtime.ts'] }],
    });
    expect(slotBlock('c', scopes, ['h2', 'h3', 'other'])).toBeNull();
    expect(slotBlock('h3', scopes, ['h1'])).toBeNull();
    expect(slotBlock('unknown', scopes, ['h1'])).toBeNull();
  });
});
