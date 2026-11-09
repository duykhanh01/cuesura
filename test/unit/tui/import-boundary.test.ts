import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// FR-036: the interface reads and writes business data only through the daemon.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function tuiImportRule(): Promise<Linter.RuleEntry> {
  const eslint = new ESLint({ cwd: ROOT });
  const config = (await eslint.calculateConfigForFile('src/tui/main.ts')) as Linter.Config;
  return config.rules?.['no-restricted-imports'] as Linter.RuleEntry;
}

async function lint(source: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-imports': await tuiImportRule() },
      },
    ],
  });
  const [result] = await eslint.lintText(source, {
    filePath: 'src/tui/views/example.ts',
  });
  return (result?.messages ?? []).map((m) => m.ruleId as string);
}

describe('src/tui import boundary', () => {
  it.each([
    "import { openStore } from '../../store/index.ts';",
    "import type { Store } from '../../store/index.ts';",
    "import { decide } from '../../engine/decide.ts';",
    "import { startDaemon } from '../../daemon/main.ts';",
    "import Database from 'better-sqlite3';",
  ])('rejects %s', async (source) => {
    expect(await lint(source)).toEqual(['no-restricted-imports']);
  });

  it.each([
    "import { callDaemon } from '../../cli/client.ts';",
    "import type { DetailCode } from '../../domain/state.ts';",
    "import { sanitize } from '../terminal/safe-text.ts';",
  ])('allows %s', async (source) => {
    expect(await lint(source)).toEqual([]);
  });
});
