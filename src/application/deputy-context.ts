/**
 * The context of a deputy turn (FR-061, R-17, contracts/deputy-turn.md#context-của-lượt): five zones in a
 * fixed order, the stable ones first so turns of one goal share a prompt-cache prefix. Zone 2 is never
 * cut; zones 3–5 get 40%, 25% and 20% of what zone 2 leaves of the byte budget, and fold their oldest
 * entries into a count line instead of dropping them silently.
 */
import type { DeputyTurn } from '../domain/deputy.ts';
import type { GoalState, Plan } from '../domain/goal.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import { parallelGroups } from '../engine/plan.ts';
import { allowedActions } from '../explain/allowed-actions.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';
import { directives } from './goal-ledger.ts';
import { openQuestions } from './inbox.ts';
import { recheckTarget } from './recheck.ts';

export const DEFAULT_CONTEXT_BYTES = 16_384;
export const ZONE_SHARES = [0.4, 0.25, 0.2] as const;

/** A zone of zones 3–5: `head` lines always stay (cut only past the zone's share); `items` fold oldest first. */
export type Zone = {
  readonly title: string;
  readonly head: readonly string[];
  /** Oldest first. */
  readonly items: readonly string[];
  /** What a folded item is, for the count line ("3 older events"). */
  readonly label: string;
};

export type BuiltContext = {
  readonly text: string;
  /** Zones 2–5 as built, in order. */
  readonly zones: readonly string[];
  /** Bytes of zones 2–5 (SC-010). */
  readonly bytes: number;
  /** Zone 2 alone was over the budget; it is still given whole (R-17). */
  readonly stable_over: boolean;
};

const size = (s: string): number => Buffer.byteLength(s, 'utf8');

function cutBytes(text: string, max: number): string {
  if (size(text) <= max) return text;
  const marker = '\n[cut]';
  const room = Math.max(0, max - size(marker));
  // Drops a partial trailing character so the result stays valid UTF-8 within the bound.
  const head = Buffer.from(text).subarray(0, room).toString('utf8').replace(/�$/, '');
  const out = `${head}${marker}`;
  return size(out) <= max ? out : '';
}

/** The zone within `max` bytes: head first, then the newest items, the rest counted on one line. */
export function fitZone(zone: Zone, max: number): string {
  const head = [`# ${zone.title}`, ...zone.head].join('\n');
  if (size(head) > max) return cutBytes(head, max);
  const kept: string[] = [];
  let used = size(head);
  for (let i = zone.items.length - 1; i >= 0; i--) {
    const line = zone.items[i] as string;
    const left = i;
    const count = left === 0 ? 0 : size(`\n- ${left} older ${zone.label} not shown`);
    if (used + 1 + size(line) + count > max) break;
    kept.unshift(line);
    used += 1 + size(line);
  }
  const folded = zone.items.length - kept.length;
  const fold = folded === 0 ? [] : [`- ${folded} older ${zone.label} not shown`];
  const out = [head, ...fold, ...kept].join('\n');
  return size(out) <= max ? out : head;
}

/** Zone 2: the request verbatim, the owner's directives in time order, the current plan. */
export function stableZone(goal: GoalState, task: TaskState | null): string {
  const lines = ['# Goal'];
  if (goal.implicit && task !== null) {
    lines.push(`title: ${task.task.title}`, 'description:', task.task.description || '(none)');
    return lines.join('\n');
  }
  lines.push(
    `goal: ${goal.id}`,
    '',
    '## Request (verbatim)',
    goal.request,
    '',
    "## Owner's directives",
  );
  const ds = directives(goal);
  if (ds.length === 0) lines.push('- none');
  for (const d of ds) lines.push(`- ${new Date(d.at).toISOString()} ${d.by}: ${d.text}`);
  lines.push('', '## Plan');
  lines.push(...planLines(goal.plan, goal.confirmed_plan_version));
  return lines.join('\n');
}

function planLines(plan: Plan | null, confirmed: number | null): string[] {
  if (plan === null) return ['none yet'];
  const out = [
    `confirmed version: ${confirmed ?? 'none'}`,
    `summary: ${plan.summary}`,
    `scope: ${plan.scope.join(', ') || 'none'}`,
    `non-goals: ${plan.non_goals.join('; ') || 'none'}`,
  ];
  for (const u of plan.units)
    out.push(
      '',
      `### ${u.key}: ${u.title}`,
      `acceptance: ${u.acceptance.join('; ')}`,
      `scope: ${u.scope?.join(', ') ?? 'none'}`,
      `depends on: ${u.depends_on.join(', ') || 'none'}`,
    );
  return out;
}

/** Puts the zones together under the budget. Pure. */
export function assembleContext(
  role: string,
  stable: string,
  zones: readonly [Zone, Zone, Zone],
  budget: number,
): BuiltContext {
  const rest = Math.max(0, budget - size(stable));
  const built = zones.map((z, i) => fitZone(z, Math.floor(rest * (ZONE_SHARES[i] as number))));
  const all = [stable, ...built];
  return {
    text: [role, ...all].join('\n\n'),
    zones: all,
    bytes: size(all.join('\n\n')),
    stable_over: size(stable) > budget,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** What the loop guard knows of the unit (007 slice C), as lines for zones 3 and 5. */
export type LoopLines = {
  readonly signals: readonly string[];
  /** Trials on the current failure signature and how each turned out. */
  readonly trials: readonly string[];
  /** The failure signature and what it is made of. */
  readonly signature: readonly string[];
  /** What the loop guard would refuse now. */
  readonly guard: readonly string[];
};

/** Zone 3 of a task's incident: history by step, then the earlier turns of this task. */
function taskZone(
  store: Store,
  s: TaskState,
  turns: readonly DeputyTurn[],
  worktree: string | null,
  loop: LoopLines | undefined,
): Zone {
  const steps = new Map<string, { n: number; bindings: Set<string>; last: string }>();
  for (const a of Object.values(s.attempts)) {
    const st = steps.get(a.step) ?? { n: 0, bindings: new Set<string>(), last: '' };
    st.n += 1;
    st.bindings.add(`${a.binding} rung ${a.rung}`);
    st.last = a.outcome?.status ?? a.outcome?.class ?? a.status;
    steps.set(a.step, st);
  }
  const history = [...steps].map(
    ([step, st]) =>
      `- step ${step}: ${st.n} attempt(s) on ${[...st.bindings].join(', ')}; last: ${st.last}`,
  );
  const ended = turns.filter((t) => t.state !== 'running' && t.state !== 'retry_wait');
  const handoffs = ended.map((t, i) => {
    const latest = i === ended.length - 1;
    const h = t.handoff;
    if (h === null)
      return `- turn ${t.turn_id} (${t.state}): no handoff; commands: ${
        store.deputy
          .commandsOfTurn(t.turn_id)
          .map((c) => c.kind)
          .join(', ') || 'none'
      }${t.final_message === null ? '' : `; last message: ${t.final_message}`}`;
    const ruled = h.ruled_out.map((r) => `${r.hypothesis} (${r.why})`).join('; ');
    return latest
      ? `- turn ${t.turn_id} (${t.state}): cause ${h.cause}; decision ${h.decision}; ruled out: ${ruled || 'none'}; next look: ${h.next_look ?? 'none'}`
      : `- turn ${t.turn_id}: decision ${h.decision}; ruled out: ${ruled || 'none'}`;
  });
  return {
    title: 'Task',
    head: [
      `id: ${s.id}`,
      `title: ${s.task.title}`,
      `unit: ${s.task.goal?.unit_key ?? 'none'}`,
      `revision: ${s.revision}`,
      `worktree (read-only): ${worktree ?? 'none yet'}`,
      ...(history.length === 0 ? ['- no attempt yet'] : []),
      ...(loop === undefined ? [] : ['## Loop signals', ...loop.signals]),
    ],
    items: [
      ...history,
      ...handoffs,
      ...(loop === undefined ? [] : ['## Trials on the current failure signature', ...loop.trials]),
    ],
    label: 'history and turn entries',
  };
}

/** Zone 4: one line per unit, the latest events of the other units, and writes of others since the last turn. */
function volatileZone(store: Store, goal: GoalState, self: string | null, since: number): Zone {
  const units = Object.entries(goal.units).map(([key, u]) => {
    const s = store.readTask(u.task_id as Uuid);
    return `- ${key} ${u.task_id}: ${s?.status ?? 'missing'}${s?.current_step ? ` step ${s.current_step}` : ''}${
      s?.wait ? ` wait ${s.wait.detail.code}` : ''
    }`;
  });
  const items: string[] = [];
  for (const u of Object.values(goal.units)) {
    if (u.task_id === self) continue;
    const evs = store.readEvents(u.task_id as Uuid).slice(-3);
    for (const e of evs) items.push(`- event ${u.task_id} #${e.seq} ${e.type}`);
  }
  const ids = Object.values(goal.units).map((u) => u.task_id);
  // FR-092: real conflicts with other live branches, the goal's units and any other task alike.
  const conflicts = store.conflicts
    .among(self === null ? ids : [self, ...ids])
    .map((c) => `- conflict ${c.task_id} x ${c.other_task_id}: ${c.files.join(', ')}`);
  for (const c of store.commandsFor([goal.id, ...ids]))
    if (c.actor !== 'deputy' && c.admitted_at > since && c.status === 'completed')
      items.push(
        `- ${iso(c.admitted_at)} ${c.actor} ${c.kind}${c.task_id === null ? '' : ` on ${c.task_id}`}: ${c.reason ?? 'no reason given'}`,
      );
  return {
    title: 'Now',
    head: [...(units.length === 0 ? ['- no unit task yet'] : units), ...conflicts],
    items,
    label: 'events and writes',
  };
}

/** Zone 5 of a task's incident. */
function incidentZone(s: TaskState, loop: LoopLines | undefined): Zone {
  const wait = s.wait;
  const question = openQuestions(s).find((q) => q.blocking) ?? null;
  const actions = allowedActions(s, {
    recheckable: recheckTarget(s) !== null,
    queuePaused: false,
  }).map(
    (a) =>
      `- ${a.action}${a.command === undefined || a.command === null ? '' : `: ${String(a.command)}`}`,
  );
  return {
    title: 'Incident',
    head: [
      `wait: ${wait?.detail.code ?? 'none'}`,
      `detail: ${JSON.stringify(wait?.detail ?? {})}`,
      ...(question === null ? [] : [`question (${question.question_id}): ${question.body}`]),
      `expected version: ${s.version}`,
      ...(loop === undefined
        ? []
        : [
            '## Failure signature',
            ...loop.signature,
            '## Loop guard on this signature',
            ...loop.guard,
          ]),
      '## Ways out',
    ],
    items: actions.length === 0 ? ['- none listed; read `cusr task explain`'] : actions,
    label: 'actions',
  };
}

/** The context of a task's incident turn. */
export function incidentContext(o: {
  readonly store: Store;
  readonly role: string;
  readonly task: TaskState;
  readonly goal: GoalState;
  readonly turns: readonly DeputyTurn[];
  readonly worktree: string | null;
  readonly budget: number;
  readonly loop?: LoopLines;
}): BuiltContext {
  const last = o.turns.at(-1);
  return assembleContext(
    o.role,
    stableZone(o.goal, o.task),
    [
      taskZone(o.store, o.task, o.turns, o.worktree, o.loop),
      volatileZone(o.store, o.goal, o.task.id, last?.started_at ?? 0),
      incidentZone(o.task, o.loop),
    ],
    o.budget,
  );
}

/** The context of a goal's `plan` turn (FR-006): why a plan is due and the units that failed. */
export function planContext(o: {
  readonly store: Store;
  readonly role: string;
  readonly goal: GoalState;
  readonly turns: readonly DeputyTurn[];
  readonly budget: number;
}): BuiltContext {
  const g = o.goal;
  const failed: string[] = [];
  for (const [key, u] of Object.entries(g.units)) {
    const s = o.store.readTask(u.task_id as Uuid);
    if (s === null || s.status !== 'FAILED') continue;
    const h = o.store.deputy
      .turnsOf({ task_id: s.id })
      .findLast((t) => t.handoff !== null)?.handoff;
    failed.push(
      `- ${key} ${s.id} FAILED: ${s.terminal?.reason ?? 'no reason'}${h === undefined || h === null ? '' : `; last handoff: ${h.decision} (${h.cause})`}`,
    );
  }
  const earlier = o.turns
    .filter((t) => t.kind === 'plan' && t.state !== 'running' && t.state !== 'retry_wait')
    .map(
      (t) =>
        `- plan turn ${t.turn_id} (${t.state}): ${t.handoff === null ? 'no handoff' : `${t.handoff.decision}; ruled out: ${t.handoff.ruled_out.map((r) => r.hypothesis).join('; ') || 'none'}`}`,
    );
  const reason = g.status === 'replan' ? `replan: ${g.replan_reason ?? 'unknown'}` : 'first plan';
  const groups = g.plan === null ? [] : (parallelGroups(g.plan) ?? []);
  const live = Object.values(g.units).filter((u) => {
    const s = o.store.readTask(u.task_id as Uuid);
    return s !== null && !isTerminal(s.status);
  }).length;
  return assembleContext(
    o.role,
    stableZone(g, null),
    [
      {
        title: 'Planning',
        head: [
          `reason: ${reason}`,
          `project: ${g.project}`,
          `base branch: ${g.base_branch}`,
          ...failed,
        ],
        items: earlier,
        label: 'earlier plan turns',
      },
      volatileZone(o.store, g, null, o.turns.at(-1)?.started_at ?? 0),
      {
        title: 'Plan due',
        head: [
          `goal version: ${g.version}`,
          `plan_version to send: ${g.plan_version}`,
          `current parallel groups: ${groups.map((l) => `[${l.join(', ')}]`).join(' ') || 'none'}`,
          `unfinished unit tasks: ${live}`,
          '## Ways out',
        ],
        items:
          g.confirmed_plan_version === null
            ? [
                `- cusr goal propose ${g.id} --expected-version ${g.version} --plan-version ${g.plan_version} --plan <file> --reason <why>`,
              ]
            : [
                `- cusr goal amend ${g.id} --expected-version ${g.version} --plan-version ${g.plan_version} --plan <file> --reason <why>`,
                '- cusr deputy handoff --decision handover (the goal waits for the owner)',
              ],
        label: 'actions',
      },
    ],
    o.budget,
  );
}
