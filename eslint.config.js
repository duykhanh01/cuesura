// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The pure core cannot access I/O, clocks, or randomness. Tests reuse this exported boundary
 * configuration.
 */
export const pureCoreRestrictedImports = {
  patterns: [
    {
      group: ['node:*'],
      message: 'The pure core must not import Node.js modules (FR-012).',
    },
    {
      group: ['better-sqlite3', 'yaml', 'uuid'],
      message: 'The pure core must not import I/O libraries.',
    },
    {
      group: ['**/store/**', '**/store', '**/config/**', '**/config'],
      message: 'The pure core must not depend on src/store or src/config.',
    },
  ],
};

export const pureCoreRestrictedGlobals = [
  {
    name: 'Date',
    message: 'Pass the current time through the trigger envelope (R-04).',
  },
  { name: 'performance', message: 'The pure core must not read the clock.' },
  {
    name: 'process',
    message: 'The pure core must not read the process environment.',
  },
  {
    name: 'setTimeout',
    message: 'The pure core must not schedule timers; emit TimerArmed instead.',
  },
  { name: 'setInterval', message: 'The pure core must not schedule timers.' },
];

export const pureCoreRestrictedProperties = [
  {
    object: 'Math',
    property: 'random',
    message: 'Derive jitter deterministically from input data (FR-012).',
  },
];

export const pureCoreRules = {
  'no-restricted-imports': ['error', pureCoreRestrictedImports],
  'no-restricted-globals': ['error', ...pureCoreRestrictedGlobals],
  'no-restricted-properties': ['error', ...pureCoreRestrictedProperties],
};

/** FR-036: the interface reaches business data only through the daemon. */
export const tuiRestrictedImports = {
  patterns: [
    {
      group: [
        '**/store/**',
        '**/store',
        '**/engine/**',
        '**/engine',
        '**/daemon/**',
        '**/daemon',
        'better-sqlite3',
      ],
      message:
        'The interface must not import the store, engine, daemon, or SQLite; go through the daemon port.',
    },
  ],
};

export const pureCoreFiles = [
  'src/engine/**/*.ts',
  'src/domain/**/*.ts',
  'src/policy/**/*.ts',
  'src/explain/**/*.ts',
];

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'reports/', 'test/fixtures/lint/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: pureCoreFiles,
    rules: pureCoreRules,
  },
  {
    // shared follows the pure-core rules; hash.ts alone may import node:crypto.
    files: ['src/shared/**/*.ts'],
    ignores: ['src/shared/hash.ts'],
    rules: pureCoreRules,
  },
  {
    files: ['src/shared/hash.ts'],

    rules: {
      ...pureCoreRules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', '!node:crypto'],
              message: 'hash.ts may only import node:crypto.',
            },
            ...pureCoreRestrictedImports.patterns.filter((p) => !p.group.includes('node:*')),
          ],
        },
      ],
    },
  },
  {
    files: ['src/store/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/config/**', '**/config'],
              message: 'src/store must not depend on src/config (R-12).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/store/**', ...pureCoreFiles, 'src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // NodeNext also resolves .js imports to testing.ts.
              group: ['**/store/testing', '**/store/testing.ts', '**/store/testing.js'],
              message: 'testing.ts is restricted to tests.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/tui/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', tuiRestrictedImports] },
  },
  {
    // Only the daemon writes to the database; runners and adapters return facts.
    files: ['src/runner/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/store/**', '**/store', '**/daemon/**', '**/daemon', 'better-sqlite3'],
              message:
                'Runners and adapters must not import the store, daemon, or SQLite; return facts through files or ports.',
            },
          ],
        },
      ],
    },
  },
);
