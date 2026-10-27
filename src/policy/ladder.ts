import {
  compareLevel,
  EFFORT_RANK,
  levelKey,
  type Binding,
  type Level,
  type Rung,
  type RungState,
} from '../domain/policy.ts';
import type { LadderStep, ModelInfo } from '../domain/config.ts';

export type { LadderStep, ModelInfo };

export type EscalationPolicy = {
  auto_up_to_tier: number;
  above: 'ask_human' | 'deny';
  allow_models: readonly string[] | null;
};

export function levelOf(b: Binding, models: Record<string, ModelInfo>): Level {
  const m = models[b.model];
  return { tier: m?.tier ?? 0, effort_rank: EFFORT_RANK[b.effort] };
}

/**
 * Trạng thái nấc (SPEC.md §9.3): model ngoài allowlist → `denied` (approval thường không mở được);
 * tier ≤ `auto_up_to_tier` → `auto`; cao hơn → `needs_approval` hoặc `denied` theo `above`.
 * Nấc 0 là binding khởi đầu đã được profile chấp nhận nên luôn `auto`.
 */
export function rungState(index: number, b: Binding, level: Level, esc: EscalationPolicy): RungState {
  if (esc.allow_models !== null && !esc.allow_models.includes(b.model)) return 'denied';
  if (index === 0) return 'auto';
  if (level.tier <= esc.auto_up_to_tier) return 'auto';
  return esc.above === 'deny' ? 'denied' : 'needs_approval';
}

/** Nấc i = nấc i−1 áp thêm bước thang i (cộng dồn). Nấc chỉ thêm context giữ mức năng lực. */
export function buildLadder(
  initial: Binding,
  steps: readonly LadderStep[],
  models: Record<string, ModelInfo>,
  esc: EscalationPolicy,
): Rung[] {
  const rungs: Rung[] = [];
  let cur = initial;
  const push = (b: Binding): void => {
    const level = levelOf(b, models);
    rungs.push({ binding: b, level, state: rungState(rungs.length, b, level, esc) });
  };
  push(cur);
  for (const s of steps) {
    const model = s.model ?? cur.model;
    const info = models[model];
    cur = {
      ...cur,
      model,
      harness: info?.harness ?? cur.harness,
      model_id: info?.id ?? cur.model_id,
      effort: s.effort ?? cur.effort,
      add_context: s.add_context ? [...cur.add_context, ...s.add_context] : cur.add_context,
    };
    push(cur);
  }
  return rungs;
}

/**
 * `floor_map[step]` (research R-18): với mỗi mức năng lực xuất hiện trong chính sách, nấc nhỏ nhất
 * trên thang của step có mức ≥ mức đó; không có thì là nấc cuối của thang.
 */
export function computeFloorMaps(ladders: Record<string, readonly Rung[]>): Record<string, Record<string, number>> {
  const levels = new Map<string, Level>();
  for (const ladder of Object.values(ladders)) for (const r of ladder) levels.set(levelKey(r.level), r.level);
  const out: Record<string, Record<string, number>> = {};
  for (const [step, ladder] of Object.entries(ladders)) {
    const map: Record<string, number> = {};
    for (const [key, lvl] of levels) {
      const idx = ladder.findIndex((r) => compareLevel(r.level, lvl) >= 0);
      map[key] = idx >= 0 ? idx : ladder.length - 1;
    }
    out[step] = map;
  }
  return out;
}
