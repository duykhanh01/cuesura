// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Ranh giới module (research R-12): lõi thuần không được chạm I/O, đồng hồ hay ngẫu nhiên.
 * Được export để test/unit/lint/boundaries.test.ts dùng lại đúng cấu hình này.
 */
export const pureCoreRestrictedImports = {
  patterns: [
    { group: ['node:*'], message: 'Lõi thuần không được import module Node (FR-012).' },
    { group: ['better-sqlite3', 'yaml', 'uuid'], message: 'Lõi thuần không được import thư viện I/O.' },
    {
      group: ['**/store/**', '**/store', '**/config/**', '**/config'],
      message: 'Lõi thuần không được phụ thuộc src/store hay src/config.',
    },
  ],
};

export const pureCoreRestrictedGlobals = [
  { name: 'Date', message: 'Thời điểm đi vào qua phong bì tín hiệu (R-04).' },
  { name: 'performance', message: 'Lõi thuần không đo thời gian.' },
  { name: 'process', message: 'Lõi thuần không đọc môi trường tiến trình.' },
  { name: 'setTimeout', message: 'Lõi thuần không hẹn giờ; dùng sự kiện TimerArmed.' },
  { name: 'setInterval', message: 'Lõi thuần không hẹn giờ.' },
];

export const pureCoreRestrictedProperties = [
  { object: 'Math', property: 'random', message: 'Jitter phải suy tất định từ dữ liệu (FR-012).' },
];

export const pureCoreRules = {
  'no-restricted-imports': ['error', pureCoreRestrictedImports],
  'no-restricted-globals': ['error', ...pureCoreRestrictedGlobals],
  'no-restricted-properties': ['error', ...pureCoreRestrictedProperties],
};

export const pureCoreFiles = [
  'src/engine/**/*.ts',
  'src/domain/**/*.ts',
  'src/policy/**/*.ts',
  'src/explain/**/*.ts',
];

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'reports/', 'test/fixtures/lint/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
    // shared là tầng nền dùng chung: cùng luật thuần, riêng hash.ts được dùng node:crypto.
    files: ['src/shared/**/*.ts'],
    ignores: ['src/shared/hash.ts'],
    rules: pureCoreRules,
  },
  {
    files: ['src/shared/hash.ts'],
    // Cùng luật thuần như phần còn lại của shared; ngoại lệ duy nhất là node:crypto (R-12).
    rules: {
      ...pureCoreRules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', '!node:crypto'], message: 'hash.ts chỉ được import node:crypto.' },
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
            { group: ['**/config/**', '**/config'], message: 'src/store không phụ thuộc src/config (R-12).' },
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
              // NodeNext cho phép viết import với đuôi .js trỏ tới testing.ts.
              group: ['**/store/testing', '**/store/testing.ts', '**/store/testing.js'],
              message: 'testing.ts chỉ dành cho kiểm thử.',
            },
          ],
        },
      ],
    },
  },
  {
    // Runner và adapter không ghi DB và không chọn trạng thái task (contracts/execution.md): chỉ daemon là writer.
    files: ['src/runner/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/store/**', '**/store', '**/daemon/**', '**/daemon', 'better-sqlite3'],
              message: 'runner/adapters không import store, daemon hay SQLite; facts trả về daemon qua file hoặc port.',
            },
          ],
        },
      ],
    },
  },
);
