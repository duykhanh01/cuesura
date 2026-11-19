/**
 * Which model a log segment came from, as the daemon persisted it. The name is read from the configured model
 * ID only: an alias such as `sonnet` stands for whatever version the config maps it to, so it never yields one.
 */
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';

export type ModelRef = {
  readonly id: SafeText | null;
  /** The alias binding of a worker attempt (`sonnet/medium`). */
  readonly binding: SafeText | null;
  readonly effort: SafeText | null;
};

const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `claude-opus-5-5` → `Opus 5.5`, `gpt-6.1-sol` → `Sol 6.1`; null for an ID of no known shape. */
export function modelName(id: string): string | null {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (claude !== null) return `${cap(claude[1] as string)} ${claude[2]}.${claude[3]}`;
  const older = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(id);
  if (older !== null)
    return `${cap(older[3] as string)} ${older[1]}${older[2] === undefined ? '' : `.${older[2]}`}`;
  const gpt = /^gpt-(\d+(?:\.\d+)*)-([a-z][a-z0-9]*)$/.exec(id);
  if (gpt !== null) return `${cap(gpt[2] as string)} ${gpt[1]}`;
  return null;
}

/** The effort of a worker binding: `sonnet/medium+x` → `medium`. */
function effortOf(binding: string): string | null {
  const m = /\/([^+/]+)/.exec(binding);
  return m === null ? null : (m[1] as string);
}

/**
 * Name, then the raw ID when the name was derived from it. Without an ID the alias stays as persisted and
 * says that the model is not known, so old data is never given a version it may not have run.
 */
export function modelLabel(m: ModelRef): SafeText {
  const effort = m.effort ?? (m.binding === null ? null : effortOf(m.binding));
  const tail = effort === null ? '' : ` · ${effort}`;
  if (m.id !== null) {
    const name = modelName(m.id);
    return uiText(name === null ? `${m.id}${tail}` : `${name} (${m.id})${tail}`);
  }
  const unknown = uiText('(model ID not recorded)');
  return m.binding === null
    ? joinSafe([unknown, uiText(tail)])
    : joinSafe([m.binding, unknown], ' ');
}

/** Short form for a narrow column: the name (or raw ID) and effort; the alias when no ID was kept. */
export function modelShort(m: ModelRef): SafeText {
  if (m.id === null) return m.binding ?? uiText('model unknown');
  const effort = m.effort ?? (m.binding === null ? null : effortOf(m.binding));
  return sanitize(`${modelName(m.id) ?? m.id}${effort === null ? '' : `/${effort}`}`);
}
