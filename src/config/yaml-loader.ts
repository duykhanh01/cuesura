import {
  isAlias,
  isNode,
  LineCounter,
  parseDocument,
  visit,
  type Node,
  type YAMLError,
} from 'yaml';
import { err, ok, type Result } from '../shared/result.ts';
import {
  diag,
  nodePosition,
  type Diagnostic,
  type DiagnosticCode,
  type LocatedDoc,
} from './positions.ts';

/** file is the caller-visible path used in diagnostics. */
export type ConfigSource = { file: string; text: string };

export type LoaderLimits = {
  /** Maximum size in UTF-8 bytes. */
  max_file_bytes: number;
  max_aliases: number;
  max_profile_depth: number;
};

export const DEFAULT_LIMITS: LoaderLimits = {
  max_file_bytes: 256 * 1024,
  max_aliases: 50,
  max_profile_depth: 8,
};

const CORE_TAGS = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((t) => `tag:yaml.org,2002:${t}`),
);

export type LoadedYaml = { located: LocatedDoc; value: unknown };

function yamlErrorCode(e: YAMLError): DiagnosticCode {
  switch (e.code) {
    case 'DUPLICATE_KEY':
      return 'duplicate_key';
    case 'TAG_RESOLVE_FAILED':
      return 'unsupported_tag';
    default:
      return 'yaml_syntax';
  }
}

/**
 * yaml reports unknown tags as warnings and resolves some non-core tags, so check tags explicitly.
 * Alias errors may appear only at toJS; validate references and counts before conversion.
 */
export function loadYaml(
  source: ConfigSource,
  limits: LoaderLimits = DEFAULT_LIMITS,
): Result<LoadedYaml, Diagnostic[]> {
  const top = { file: source.file, line: 1, col: 1 };
  const bytes = new TextEncoder().encode(source.text).byteLength;
  if (bytes > limits.max_file_bytes) {
    return err([
      diag(
        'file_too_large',
        top,
        [],
        `File size ${bytes} bytes exceeds the limit of ${limits.max_file_bytes} bytes`,
      ),
    ]);
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(source.text, {
    schema: 'core',
    uniqueKeys: true,
    lineCounter,
    prettyErrors: true,
  });
  const located: LocatedDoc = { file: source.file, doc, lineCounter };

  const out: Diagnostic[] = [];
  for (const e of [...doc.errors, ...doc.warnings]) {
    const lp = e.linePos?.[0] ?? lineCounter.linePos(e.pos[0]);
    const message = e.message.split('\n')[0] ?? e.message;
    out.push(
      diag(yamlErrorCode(e), { file: source.file, line: lp.line, col: lp.col }, [], message),
    );
  }

  const anchors = new Set<string>();
  let aliases = 0;
  visit(doc, (_key, node) => {
    if (!isNode(node)) return;
    const n = node as Node;
    if (n.anchor) anchors.add(n.anchor);
    if (isAlias(n)) {
      aliases += 1;
      if (aliases === limits.max_aliases + 1) {
        out.push(
          diag(
            'alias_limit',
            nodePosition(located, n),
            [],
            `Alias count exceeds the limit of ${limits.max_aliases}`,
          ),
        );
      }
      if (!anchors.has(n.source)) {
        out.push(
          diag(
            'yaml_syntax',
            nodePosition(located, n),
            [],
            `Alias '*${n.source}' has no preceding anchor`,
          ),
        );
      }
      return;
    }
    if (n.tag !== undefined && !CORE_TAGS.has(n.tag)) {
      // Unknown tags already have TAG_RESOLVE_FAILED warnings; add diagnostics only for resolved non-core tags.
      if (!n.tag.startsWith('!')) {
        const lp = lineCounter.linePos(tagStart(source.text, n.range?.[0] ?? 0));
        out.push(
          diag(
            'unsupported_tag',
            { file: source.file, line: lp.line, col: lp.col },
            [],
            `Tag '${n.tag}' is not part of the YAML core schema`,
          ),
        );
      }
    }
  });

  if (out.length > 0) return err(dedupe(out));
  try {
    const value: unknown = doc.toJS({
      maxAliasCount: limits.max_aliases * limits.max_aliases,
    });
    return ok({ located, value });
  } catch (e) {
    // Nested aliases can exceed maxAliasCount even when the number of alias nodes is within the limit.
    return err([
      diag('alias_limit', top, [], `Alias expansion exceeds the limit: ${(e as Error).message}`),
    ]);
  }
}

/** Node ranges start at the value; find the preceding explicit tag token for its diagnostic. */
function tagStart(text: string, valueStart: number): number {
  let i = text.lastIndexOf('!', valueStart);
  if (i < 0) return valueStart;
  while (i > 0 && !/[\s,[{:]/.test(text[i - 1] as string)) i -= 1;
  return i;
}

function dedupe(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const k = `${d.code}:${d.line}:${d.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
