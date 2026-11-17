# Nâng cấp user config: graph workflow chuyển vào code

Từ bản này, graph workflow (bước, `kind`, role, action, predicate, cạnh, outcome) cố định trong code:
[`src/engine/workflows/software-dev.ts`](../src/engine/workflows/software-dev.ts). User config
(`~/.cusr/config.yaml`) không khai graph nữa; nó chỉ chọn graph dựng sẵn và chỉnh vài tham số daemon có đọc.

Trước đây cú pháp cho khai cả graph, nhưng daemon từ chối mọi graph khác `software_dev@1` khi đóng băng
policy. Thực tế các config chạy được chỉ có `base: software_dev@1` kèm tham số của bước.

## Có cần sửa config không

Không cần nếu mọi workflow chỉ có `base: software_dev@1`, có hoặc không kèm `steps` mà mỗi bước chỉ chứa
tham số ở bảng dưới. Config dogfood (`impl: { base: software_dev@1 }`) thuộc trường hợp này.

Cần sửa nếu `cusrd` không khởi động hoặc `cusr doctor` báo check `config` thất bại với lỗi như:

```text
config.yaml:52:15 workflow_key_removed: 'uses' can no longer be set: the software_dev@1 graph is fixed in code; remove workflows.impl.steps.code.uses (docs/config-upgrade.md)
```

## Cách sửa

1. Với mỗi lỗi `workflow_key_removed`, xóa đúng khóa được nêu trong đường dẫn (`workflows.<tên>.…`).
2. Workflow không có `base` (khai `start` và toàn bộ `steps`): thay bằng `base: software_dev@1` và chỉ giữ
   tham số ở bảng dưới. Graph tự khai trước đây vẫn không chạy được, nên không có hành vi nào bị mất.
3. Lỗi `unknown_step`: bước không có trong `software_dev@1`; xóa cả mục bước đó.
4. Lỗi `schema_invalid` dạng `Step '<bước>' does not take '<khóa>'; accepted: …`: bước đó không nhận
   tham số này; xóa hoặc chuyển sang bước nhận được.
5. Chạy `cusr doctor`, khởi động lại `cusrd`.

Ví dụ trước và sau:

```yaml
# Trước
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { uses: [claude], max_visits: 10 }
      gates: { uses: [build] }
      review: { skip_when: { size: [XS, S] } }

# Sau
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { max_visits: 10 }
```

## Tham số còn chỉnh được

`base: software_dev@1` là bắt buộc. Mỗi tham số dưới đây đều được daemon đọc; bước nào không có trong
bảng thì không nhận tham số nào.

| Tham số | Bước nhận | Daemon dùng ở đâu |
|---|---|---|
| `max_visits` | Bước đã có giới hạn lượt: `scout`, `code`, `gates`, `fix_gates`, `review`, `fix_review`, `publish`, `ci`, `ci_triage`, `rerun_ci`, `ci_autofix`, `ci_fix`, `merge` | Trần số lượt vào bước; hết lượt thì đi theo `on_exhausted` của graph (thường là `escalate`) |
| `max_rung` | Bước agent/review: `scout`, `code`, `fix_gates`, `review`, `fix_review`, `ci_fix` | Cắt thang escalation của role khi đóng băng policy |
| `run`, `required` | Bước gate: `gates`, `ci_autofix` | Tên gate logic chạy và gate bắt buộc; `required` phải nằm trong `run` |
| `poll`, `timeout` | Bước chờ CI: `ci` | Chu kỳ poll và tổng thời gian chờ required checks |

Các bước chưa có giới hạn lượt (`triage`, `prepare`, `pr`, `merge_gate`, `complete`) không nhận
`max_visits`, để mọi bước có giới hạn luôn có đích `on_exhausted` trong graph.

## Khóa đã bỏ

| Khóa | Vì sao bỏ |
|---|---|
| `start`, bước mới, `kind`, `action`, `for`, `rules`, `next`, `on_exhausted` | Là cấu trúc graph; mọi thay đổi đều bị từ chối qua `structure_hash` |
| `role` | Daemon chỉ chạy các role cố định của graph; đổi role của bước làm preflight thất bại |
| `uses` | Không bước nào đọc lúc chạy |
| `when`, `skip_when`, `auto_when` | Đổi bước chạy hay bỏ qua review/merge approval của graph; `full-review` và `direct-pr` tự quyết review, merge do policy và yolo quyết |
| `decisions` | Đã bỏ từ #65; câu hỏi của worker tới deputy (role `deputy`, thay decider từ feature 007) khi bật `autonomous: true` ở gốc user config, không theo workflow |

## Task cũ

Policy snapshot của task đã đóng băng giữ nguyên workflow lúc đó, kể cả các khóa nay không khai được
(`uses`, `skip_when`, …). Task cũ vẫn đọc, replay, verify hash và chạy tiếp như trước; không có migration
và không sửa event hay snapshot. Hash `user` và `policy` của task mới không đổi với config chỉ dùng tham
số trong bảng trên.
