/**
 * The guidance a new install starts with. There is no install step to hook, so cusrd writes it on start and
 * then leaves the file to the user. Names come from the user config: only the model ids are fixed here.
 */
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { dispatchFilePath, readDispatchFile } from './read-files.ts';
import { validateDispatchFile, type Validated } from './validate.ts';

const WORKER_MODEL_ID = 'claude-opus-5-5';
const REVIEWER_MODEL_ID = 'gpt-6.1-sol';

/** The file's text, or null when no profile of this config can run the default choice. */
export function defaultDispatchText(file: string, validated: Validated): string | null {
  const { models } = validated.config.user;
  const named = (id: string) => Object.entries(models).find(([, m]) => m.id === id);
  const worker = named(WORKER_MODEL_ID);
  const reviewer = named(REVIEWER_MODEL_ID);
  if (worker === undefined || reviewer === undefined) return null;
  for (const profile of Object.keys(validated.config.profiles).sort()) {
    const text = stringify({
      version: 1,
      profile,
      rules: [],
      default: {
        use: { harness: worker[1].harness, model: worker[0], effort: 'medium' },
        reviewer: { harness: reviewer[1].harness, model: reviewer[0], effort: 'high' },
        why: 'Default for code changes.',
      },
    });
    if (validateDispatchFile({ file, text }, validated).ok) return text;
  }
  return null;
}

export type DefaultDispatchResult = 'created' | 'exists' | 'unavailable';

export async function ensureDefaultDispatch(
  configPath: string,
  validated: Validated,
): Promise<DefaultDispatchResult> {
  if ((await readDispatchFile(configPath)) !== null) return 'exists';
  const file = dispatchFilePath(configPath);
  const text = defaultDispatchText(file, validated);
  if (text === null) return 'unavailable';
  try {
    await writeFile(file, text, { flag: 'wx' });
    return 'created';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw e;
  }
}
