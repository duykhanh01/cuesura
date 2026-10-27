import { isAlias, isNode, LineCounter, parseDocument, visit, type Node, type YAMLError } from 'yaml';
import { err, ok, type Result } from '../shared/result.ts';
import { diag, nodePosition, type Diagnostic, type DiagnosticCode, type LocatedDoc } from './positions.ts';

/** Nội dung một file cấu hình đã đọc; `file` là đường dẫn caller muốn thấy trong chẩn đoán. */
export type ConfigSource = { file: string; text: string };

export type LoaderLimits = {
  /** Kích thước tối đa mỗi file, tính bằng byte UTF-8. */
  max_file_bytes: number;
  max_aliases: number;
  max_profile_depth: number;
};

export const DEFAULT_LIMITS: LoaderLimits = {
  max_file_bytes: 256 * 1024,
  max_aliases: 50,
  max_profile_depth: 8,
};

/** Tag được phép: chỉ các kiểu của YAML core schema (R-05). `!!binary`, `!!set`… bị từ chối. */
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
 * Parse một file cấu hình theo R-05. Hành vi đã kiểm chứng với `yaml` 2 (test/unit/config/loader.test.ts):
 * key trùng là `doc.errors` `DUPLICATE_KEY`; tag lạ chỉ là `doc.warnings` `TAG_RESOLVE_FAILED`; `!!binary`
 * vẫn được resolve dù dùng core schema nên phải lọc tag riêng; alias vượt giới hạn hay alias chưa khai
 * báo chỉ ném lỗi ở `toJS`, nên loader tự đếm và kiểm alias trước.
 */
export function loadYaml(source: ConfigSource, limits: LoaderLimits = DEFAULT_LIMITS): Result<LoadedYaml, Diagnostic[]> {
  const top = { file: source.file, line: 1, col: 1 };
  const bytes = new TextEncoder().encode(source.text).byteLength;
  if (bytes > limits.max_file_bytes) {
    return err([
      diag('file_too_large', top, [], `file ${bytes} byte vượt giới hạn ${limits.max_file_bytes} byte`),
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
    out.push(diag(yamlErrorCode(e), { file: source.file, line: lp.line, col: lp.col }, [], message));
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
        out.push(diag('alias_limit', nodePosition(located, n), [], `quá ${limits.max_aliases} alias`));
      }
      if (!anchors.has(n.source)) {
        out.push(diag('yaml_syntax', nodePosition(located, n), [], `alias '*${n.source}' chưa có anchor trước đó`));
      }
      return;
    }
    if (n.tag !== undefined && !CORE_TAGS.has(n.tag)) {
      // Tag lạ đã có cảnh báo TAG_RESOLVE_FAILED; chỉ báo thêm tag đã resolve nhưng ngoài core.
      if (!n.tag.startsWith('!')) {
        const lp = lineCounter.linePos(tagStart(source.text, n.range?.[0] ?? 0));
        out.push(diag('unsupported_tag', { file: source.file, line: lp.line, col: lp.col }, [], `tag '${n.tag}' không thuộc core schema`));
      }
    }
  });

  if (out.length > 0) return err(dedupe(out));
  try {
    const value: unknown = doc.toJS({ maxAliasCount: limits.max_aliases * limits.max_aliases });
    return ok({ located, value });
  } catch (e) {
    // Alias lồng nhau có thể vượt `maxAliasCount` của `yaml` dù số node alias chưa vượt giới hạn.
    return err([diag('alias_limit', top, [], `mở rộng alias vượt giới hạn: ${(e as Error).message}`)]);
  }
}

/** `range` của node bắt đầu ở giá trị; lùi về đầu token tag (`!!binary`) đứng trước nó. */
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
