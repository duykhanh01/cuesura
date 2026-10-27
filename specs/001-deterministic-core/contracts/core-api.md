# Contract: Giao diện lập trình công khai

Export từ `src/index.ts`. Đây là bề mặt mà feature runner, daemon và CLI sau này sẽ dùng; thay đổi
không tương thích cần ghi trong plan của feature đó. Chữ ký dưới là hợp đồng, không phải mã triển khai.

## Kiểu nền

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type Uuid = string & { readonly __brand: 'Uuid' };
type EpochMs = number & { readonly __brand: 'EpochMs' };
type Hash = `sha256:${string}`;
```

## Cấu hình và chính sách (thuần, trừ `readConfigFiles`)

```ts
type ConfigSource = { file: string; text: string };

// Shell mỏng: đọc file từ đĩa. Mọi hàm khác nhận nội dung đã đọc.
function readConfigFiles(paths: { user: string; project?: string }): Promise<ConfigSource[]>;

function validateConfig(input: {
  user: ConfigSource;
  project?: ConfigSource;            // cusr.yaml tại base_sha
  packs: Record<string, ConfigSource>;
  limits?: Partial<LoaderLimits>;
}): Result<{ config: ValidatedConfig; unsupported: UnsupportedFeature[] }, Diagnostic[]>;

// Cấu hình hợp lệ nhưng có phần chưa chạy được ở feature này (FR-039, FR-041, research R-20).
type UnsupportedFeature = {
  code: 'decision_mode_unsupported' | 'unsupported_workflow';
  workflow: string;
  points?: string[];                 // điểm quyết định dùng chế độ chưa hỗ trợ
  file: string; line: number; col: number;
};

function freeze(input: {
  config: ValidatedConfig;
  task: CanonicalTask;
  overrides?: TaskOverrides;
  caller: AuthzContext;
  base_sha: string;
  attachments: { name: string; media_type: string; content: string }[];
  prompts?: { name: string; content: string }[];      // theo `roles.<r>.prompt` của các role được dùng
  conventions?: { name: string; content: string }[];  // theo `conventions` của cusr.yaml
}): Result<{ policy: FrozenPolicy; context: FrozenExecutionContext }, FreezeError>;
// Prompt, conventions và attachment được chụp kèm `content_hash` vào ngữ cảnh (FR-037); thiếu nội dung
// của một tài liệu được tham chiếu thì trả `config_invalid` và không chốt snapshot nào (FR-038).

type FreezeError =
  | { code: 'config_invalid'; diagnostics: Diagnostic[] }
  | { code: 'unsupported_workflow'; workflow: string; structure_hash: Hash }
  | { code: 'unsupported_decision_mode'; points: string[] }
  | { code: 'no_valid_binding'; step: string; role: string }
  | { code: 'override_exceeds_caller'; keys: string[] };

function proposeAmendment(input: {
  current: FrozenPolicy;
  change: PolicyChange;              // không gồm thay đổi graph workflow
  reason: string;
  authz: AuthzContext;
}): Result<FrozenPolicy, { code: 'not_admin' | 'workflow_change_forbidden' | 'invalid' }>;
```

`freeze` và `proposeAmendment` chỉ tạo dữ liệu; kết quả chỉ có hiệu lực khi được đưa vào kho qua tín
hiệu `start` hoặc `amend` (contracts/signals-events.md).

## Lõi quyết định (thuần)

```ts
type DecideInput = {
  state: TaskState | null;           // null khi task chưa tồn tại
  policy: FrozenPolicy | null;       // chính sách hiệu lực của revision hiện tại
  envelope: TriggerEnvelope;
  related: RelatedFacts;             // kho đọc trong cùng transaction (signals-events.md)
};

type Decision =
  | { kind: 'accepted'; events: DomainEventDraft[] }   // có thể rỗng ngoài SignalIgnored
  | { kind: 'rejected'; code: RejectCode; detail?: unknown };

function decide(input: DecideInput): Decision;
function evolve(state: TaskState | null, event: DomainEvent): TaskState;
```

- `DomainEventDraft` là sự kiện chưa có `seq`/`global_seq`; kho gán khi append.
- Cùng `DecideInput` luôn cho `Decision` bằng nhau theo JSON chuẩn hoá (FR-012, SC-004).
- `evolve` ném lỗi lập trình khi sự kiện tạo chuyển trạng thái không hợp lệ; không bao giờ ném với nhật
  ký do `decide` tạo ra.

## Kho trạng thái (có I/O, đồng bộ)

```ts
function openStore(path: string, opts?: { busyTimeoutMs?: number }): Result<Store, StoreOpenError>;
// StoreOpenError: 'store_locked' | 'schema_incompatible' | 'integrity_failed' | 'io_error'

interface Store {
  accept(envelope: TriggerEnvelope): Result<AcceptOutcome, AcceptError>;
  claimEffect(effectId: Uuid, now: EpochMs): Result<Effect, ClaimError>;
  dueTimers(now: EpochMs, limit: number): Timer[];
  fireDueTimers(now: EpochMs, limit: number, ids: (timerId: Uuid) => Uuid[]): Result<AcceptOutcome[], FireError>;
  pendingEffects(limit: number): Effect[];
  readTask(taskId: Uuid): TaskState | null;
  readEvents(taskId: Uuid, fromSeq?: number): DomainEvent[];
  readPolicy(taskId: Uuid, revision: number, policyVersion?: number): FrozenPolicy | null; // mặc định: version mới nhất
  readContext(taskId: Uuid, revision: number): FrozenExecutionContext | null;
  verifyProjections(): VerifyReport;  // dựng lại tasks/effects/timers từ events và so sánh
  close(): void;
}

type AcceptOutcome = {
  dedup_key: string;
  duplicate: boolean;                // true: trả kết quả của lần chấp nhận đầu (FR-026)
  decision: Decision;
  task_version: number | null;
  global_seq_range: [number, number] | null;
};

type ClaimError =
  | { code: 'effect_invalidated' | 'not_pending' | 'not_found' }
  | { code: 'claim_blocked'; reason: 'stale_revision' | 'source_drift' | 'cancelling' | 'terminal' | 'deadline' | 'task_waiting' }
  | { code: 'write_failed'; cause: 'disk_full' | 'busy' | 'io_error' };   // như AcceptError: transaction đã rollback
// claim_blocked: effect vẫn pending; điều kiện do hàm thuần claimable(state, effect, now) quyết (R-16).

type AcceptError =
  | { code: 'conflict'; reason: 'request_hash_mismatch' | 'stale_version' | 'id_collision' }
  | { code: 'write_failed'; cause: 'disk_full' | 'busy' | 'io_error' };   // FR-033

type FireError = AcceptError & { fired: AcceptOutcome[] };   // fired: tín hiệu đã commit trước lỗi
```

- `accept` chạy trong một transaction `BEGIN IMMEDIATE`: dedup → đọc state + policy → `decide` → append
  → projection → commit. Không có `await` bên trong (FR-025).
- Dedup so `request_hash` = hash của `{ task_id, trigger, expected_version, actor }`; `now`/`ids` không
  tham gia (R-19).
- `claimEffect` đọc projection của task, gọi `claimable`, rồi append `EffectStarted` trong cùng một
  transaction. Effect `stop_attempt` và `reconcile` không bị chặn bởi source drift hay hủy.
- `Decision.rejected` vẫn được ghi vào `accepted_triggers` để lần gửi lại trả cùng kết quả; không có sự
  kiện nào được append. Ngoại lệ: `id_pool_exhausted` không được ghi, vì nó phụ thuộc `ids` mà `ids`
  không thuộc request hash; gửi lại cùng khoá với đủ ID sẽ được xử lý thật.
- `conflict id_collision`: một ID trong `ids` được dùng để tạo effect/timer nhưng đã thuộc về một dòng
  có sẵn (caller cấp lại pool cũ). Transaction rollback, không ghi dedup; gửi lại với ID mới.
- `write_failed` nghĩa là transaction đã rollback; caller không được coi trạng thái mới là đã lưu.
- `fireDueTimers` xử lý từng timer trong transaction riêng; tham số `ids` cấp ID cho phong bì (R-04).
  Dừng ở lỗi đầu tiên và trả `FireError` (FR-033); timer chưa xử lý giữ `armed`. Timer bị từ chối vì
  `id_pool_exhausted` vẫn đến hạn ở lần gọi sau (FR-030).

## Giải thích (thuần)

```ts
function explain(state: TaskState, events: DomainEvent[], policy: FrozenPolicy): Explanation;

type Explanation = {
  status: TaskStatus;
  step: string | null;
  wait: { reason: WaitReason; detail: unknown; resume_when: string[]; exit_paths: string[] } | null;
  bindings_used: { step: string; rung: number; binding: string; attempts: number }[];
  remaining: { agent_runs: number; reserved: number; wall_ms: number | null; escalations: number };
  escalations: { step: string; from: number; to: number; signature: string; event_seq: number }[];
  pending_effects: { id: Uuid; kind: string; status: 'started' | 'unknown' }[];
  cancellation: { requested_at: EpochMs; late: boolean } | null;
};
```

Mọi trường được tính từ dữ liệu vào; không có lời gọi LLM hay I/O (FR-034).

## Entry chỉ dành cho kiểm thử

`src/store/testing.ts` export `openMemoryStore()` (R-09) và hook crash injection (R-08). Entry này không
nằm trong `src/index.ts`; ESLint cấm import nó từ `src/**` ngoài chính thư mục `store`.
