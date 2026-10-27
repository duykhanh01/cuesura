import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../fixtures/lint/engine-violation.ts', import.meta.url));

/** Luật ranh giới mà cấu hình thật của repo áp cho một file trong src/engine (R-12). */
async function engineRules(): Promise<Partial<Linter.RulesRecord>> {
  const eslint = new ESLint({ cwd: ROOT });
  const config = (await eslint.calculateConfigForFile('src/engine/decide.ts')) as Linter.Config;
  const rules = config.rules ?? {};
  return {
    'no-restricted-imports': rules['no-restricted-imports'],
    'no-restricted-globals': rules['no-restricted-globals'],
    'no-restricted-properties': rules['no-restricted-properties'],
  };
}

describe('Ranh giới lõi thuần bằng ESLint (T111, I01)', () => {
  it('cấu hình của src/engine/** bật đủ ba luật chặn I/O, đồng hồ và ngẫu nhiên', async () => {
    const rules = await engineRules();
    for (const [name, value] of Object.entries(rules)) {
      // ESLint chuẩn hoá mức lỗi thành số: 2 = error.
      expect(Array.isArray(value) ? value[0] : value, name).toBe(2);
    }
  });

  it('fixture import node:fs, dùng Date.now() và Math.random() bị báo đủ lỗi', async () => {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          rules: await engineRules(),
        },
      ],
    });
    const [result] = await eslint.lintFiles([FIXTURE]);
    const found = (result?.messages ?? []).map((m) => `${m.ruleId}:${m.line}`).sort();
    expect(found).toEqual([
      'no-restricted-globals:7',
      'no-restricted-imports:3',
      'no-restricted-properties:7',
    ]);
  });
});
