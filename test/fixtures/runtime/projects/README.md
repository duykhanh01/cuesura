# Fixture smoke (T121)

Hai project nhỏ không có dependency, dùng cho `test/smoke/`. Mỗi project gồm:

- `repo/`: nội dung ban đầu của repo sandbox, gồm `cusr.yaml` và workflow CI. Gate của `repo/` xanh.
- `task.json`: task thật giao cho coder, đầu vào của `cusr task add --file`.
- `variants/pass/`: một lời giải đúng. Chép đè lên `repo/` thì gate xanh.
- `variants/fail/`: cùng test nhưng lời giải sai. Chép đè lên `repo/` thì gate `unit` đỏ, gate khác vẫn xanh.

`prompts/` là prompt role đặt cạnh user config. Không file nào ở đây chứa credential; user config của
lượt thật chỉ nêu đường dẫn tới credential (`runtime.credential_refs`).

## Chạy thật (opt-in)

`pnpm test:smoke` không gọi model nếu thiếu `CUSR_SMOKE_REAL`. Biến này trỏ tới file JSON của người vận hành (schema ở
`test/support/smoke-real.ts`): `approval` (ai duyệt budget nào), `ledger`, và với mỗi `node`/`python` có `config`,
`data_dir`, `repo`, `run`. Mỗi chiều vendor có config và data dir riêng vì binding role là toàn cục trong một config.
Cần `pnpm build`, harness record của owner và repo sandbox trước. Đặt `-t` để chọn đúng kịch bản, vì mỗi suite có thể
tiêu usage và mở PR.
