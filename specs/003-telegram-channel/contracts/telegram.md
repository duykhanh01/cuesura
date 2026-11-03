# Hợp đồng kênh Telegram

Hành vi người dùng thấy trong chat và cách daemon dùng Bot API. Giá trị số theo
[R-04](../research.md#r-04--gửi-lượt-đợt-thứ-tự) và [R-08](../research.md#r-08--liên-kết-mã-và-grant).

## Ai được nói chuyện với bot

| Nguồn | Xử lý |
| --- | --- |
| Chat riêng, đúng `chat_id` và `user_id` của liên kết đang hoạt động | Xử lý theo grant của liên kết |
| Chat riêng chưa liên kết, gửi `/start <mã>` | Được tách riêng trước bước loại người lạ và lưu dạng `pairing` (chỉ giữ băm của mã); luồng liên kết; một phản hồi chung về kết quả |
| Mọi nguồn khác: chat riêng khác, nhóm, kênh, người khác trong nhóm, `/start` không mã | Bỏ qua, không phản hồi, chỉ lưu metadata |

Phản hồi khi mã sai, hết hạn, đã dùng hay đã hủy giống hệt nhau: "Mã liên kết không hợp lệ hoặc đã hết hạn."

## Lệnh trong chat

| Lệnh | Quyền | Kết quả |
| --- | --- | --- |
| reply vào bản tin câu hỏi | operate | Trả lời câu hỏi đó |
| `/answer <mã> <nội dung>` | operate | Trả lời câu hỏi có mã ngắn đó |
| nút "Duyệt" | admin | `approve_escalation` với phạm vi của thẻ |
| nút "Xác nhận" | operate | `task_confirm` với `run_config_digest` của thẻ |
| `/inbox` | read | Trang inbox đầu, 8 mục mỗi tin; nút "Mở" cho mục thao tác được, nút "Trang sau" |
| `/show <mã>` hoặc nút "Mở" | read | Gửi thẻ hiện hành của mục đó, dựng lại từ state |
| `/report [khoảng]` | read | Như `cusr report --since`, mặc định `24h` |
| `/help` | read | Danh sách lệnh và lệnh CLI tương đương |

Tin khác (văn bản tự do, ảnh, file, giọng nói, sticker, tin đã sửa): một phản hồi hướng dẫn kèm số việc đang chờ; không đoán
ý, không tạo task. Tin sửa của một reply đã ghi nhận nhận phản hồi rằng câu trả lời đã ghi không đổi (EC-003).

## Mẫu tin

Văn bản thuần, không `parse_mode`. Mọi chuỗi đi qua Redactor.

```text
[acme] Add retry to webhook sender
❓ Câu hỏi Q7K2MX · task 01HZ…  · bước code
<nội dung câu hỏi>

Reply tin này để trả lời, hoặc: /answer Q7K2MX <nội dung>
CLI: cusr answer <question_id> --file <file> --expected-version <n>
ref a8Kq2ZxP0d
```

Dòng `ref <card_id>` trỏ tới thẻ `answer` duy nhất của câu hỏi theo liên kết đã gửi, và luôn là dòng cuối của tin câu hỏi, kể cả sau khi cắt nội dung dài hay sửa thành
trạng thái cuối. Reply vào một bản tin không có trong `message_copies` (lượt gửi `unknown`) được định tuyến bằng dòng này,
chỉ khi tin gốc do chính bot gửi ([R-09](../research.md#r-09--thao-tác-từ-telegram-đi-qua-đường-lệnh-có-sẵn)).

```text
[acme] Add retry to webhook sender
⏫ Xin nâng model · bước code · nấc 2/3
claude-sonnet-5-5/high → claude-opus-5-5/high · còn 1 nấc sau nấc này
Không duyệt thì task đứng chờ. Muốn bỏ: cusr task cancel <id>, rồi tạo task mới.
[ Duyệt ]
```

Chat chỉ có `operate`: thay nút bằng dòng "Cần quyền admin: cusr task approve <id> --kind escalation --step code --rung 2".

```text
[acme] Add retry to webhook sender
✅ Chờ xác nhận · revision 1 · direct-pr · codex/gpt-5.5/medium
Acceptance: <tóm tắt>
Đổi cấu hình: cusr task propose … hoặc mở cusr
[ Xác nhận ]
```

Trạng thái cuối được sửa vào chính bản tin, bỏ nút, thêm một dòng ngay trên dòng `ref` (nếu có): "Đã trả lời bởi telegram:… lúc 09:12", "Đã duyệt bởi
owner qua CLI lúc 09:15", "Hết hiệu lực: task đã sang revision 2".

## Phản hồi thao tác

Mỗi update dẫn tới đúng một phản hồi logic, gửi reply vào tin của người dùng:

| Kết quả | Phản hồi |
| --- | --- |
| Đã ghi | "Đã ghi câu trả lời cho Q7K2MX, task tiếp tục." / "Đã duyệt nấc 2." / "Đã xác nhận." |
| Câu trả lời chứa giá trị giống secret | "Chưa ghi: câu trả lời có nội dung giống secret nên không lưu qua Telegram. Câu hỏi vẫn mở: gửi lại không kèm giá trị đó, hoặc trả lời trên máy bằng `cusr answer`." Không có lệnh nào được gửi |
| Lặp lại | Giống lần đầu (cùng `request_id`) |
| Đã xử lý trước đó | "Đã được trả lời bởi <actor> qua <kênh> lúc <giờ>." |
| Hết hiệu lực | "Hết hiệu lực: <lý do>. Gõ /inbox để xem việc hiện tại." |
| Thiếu quyền | "Cần quyền <role>. Lệnh CLI: …" |
| Mơ hồ | "Mã Q7K2 khớp nhiều câu hỏi: …" |
| Lỗi cú pháp | Cách dùng đúng của lệnh |

Nút luôn được `answerCallbackQuery` ngay với chữ ngắn ("Đang xử lý…"); phản hồi đầy đủ là một tin riêng.

## Liên kết

```text
$ cusr telegram link --role admin
Gửi mã này cho @acme_cusr_bot trong 10 phút:  /start q3V…
Hoặc mở: https://t.me/acme_cusr_bot?start=q3V…
Đang chờ… ✓ Đã liên kết chat 5551234 (telegram:5551234), quyền read, operate, admin, project acme.
```

Sau khi liên kết, bot gửi "Đã liên kết với Cuesura trên <host>." và lần lượt các việc còn chờ (FR-031).

## Dùng Bot API

| Việc | Method | Ghi chú |
| --- | --- | --- |
| Kiểm token, lấy bot | `getMe` | Khi setup và khi daemon khởi động |
| Phát hiện webhook | `getWebhookInfo` | Setup, doctor |
| Gỡ webhook | `deleteWebhook` | Chỉ với `--drop-webhook` |
| Nhận | `getUpdates` | `timeout=25`, `allowed_updates=["message","edited_message","callback_query"]` |
| Gửi | `sendMessage` | `reply_parameters` khi phản hồi; `reply_markup` khi có thẻ |
| Đồng bộ trạng thái cuối | `editMessageText` | Bỏ `reply_markup`; `message is not modified` coi là xong |
| Tắt vòng chờ nút | `answerCallbackQuery` | Ngay khi nhận |
| Kiểm đường gửi | `sendChatAction` | `typing`, chỉ khi đường gửi đang hỏng |

Phân loại lỗi:

| Lỗi | Xử lý |
| --- | --- |
| Timeout, lỗi mạng trước khi có phản hồi | `unknown`; lượt sau gửi lại cùng nội dung |
| HTTP 429 | Dừng mọi lượt tới `retry_after`; không tính là lượt hỏng |
| HTTP 5xx | Lượt hỏng, backoff |
| 401/404 token | Kênh `token_invalid`; dừng gửi/nhận tới khi setup lại |
| 403 bot bị chặn | Lượt hỏng; đánh dấu `send_failing_since`; doctor báo |
| 400 `message to edit not found`, `message can't be edited` | Bản tin `gone` |
| 400 khác | Lượt hỏng, ghi lỗi; không thử lại nếu cùng lỗi lặp lại hết đợt |
| 409 ở `getUpdates` | `receive_conflict`, backoff |
