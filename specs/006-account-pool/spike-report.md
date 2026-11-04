# Spike report: feature 006

Báo cáo cho spike S1–S5 ở [R-12](research.md#r-12--spike-trước-khi-code). **Trạng thái 2026-11-04:** đã xong phân tích
tĩnh, thử nghiệm khóa trên credential giả (Phần 2a) và thử nghiệm với tài khoản phụ (Phần 2b). S2, S4, S5 có kết luận (Orca
qua phân tích mã nguồn); S3 đạt một phần; S1 chưa chạy vì thiếu tài khoản Claude phụ thứ hai.

## Phạm vi và phiên bản

| Thành phần | Phiên bản | Nguồn phân tích |
| --- | --- | --- |
| Claude Code | 2.1.317 (build 2026-11-02, `3d3e7cb`) | Chuỗi trong binary Bun (`~/.local/share/claude/versions/2.1.317`) |
| Codex CLI | 0.166.0 (`x86_64-unknown-linux-musl`) | Chuỗi trong binary Rust |
| Orca | Không cài trên máy này; `~/.orca` chỉ có `agent-hooks` | Chưa phân tích được |
| Công cụ hệ thống | `flock` (util-linux 2.37.2), `strace` có sẵn | — |

Khi đọc file credential, mình chỉ in **tên khóa JSON**, không in giá trị nào.

## Phần 1 — Phân tích tĩnh

### S3: danh tính

| Vendor | File credential | Có danh tính trong file? | Nơi có danh tính |
| --- | --- | --- | --- |
| Claude | `<config dir>/.credentials.json`: `claudeAiOauth.{accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType, subscriptionTypeSource, rateLimitTier}` | **Không** | `oauthAccount.{accountUuid, organizationUuid, emailAddress, …}` trong `.claude.json`: `~/.claude.json` với cấu hình mặc định, `$CLAUDE_CONFIG_DIR/.claude.json` khi đặt biến này |
| Codex | `$CODEX_HOME/auth.json`: `auth_mode`, `tokens.{id_token, access_token, refresh_token, account_id, login_owner_id, oauth_provenance}`, `last_refresh` | **Có**: `tokens.account_id` | Codex tự dùng `account_id` để từ chối nạp lại credential của tài khoản khác ("Skipping auth reload due to account id mismatch") |

Hệ quả cho R-07: với Codex, danh tính đọc thẳng từ nguồn. Với Claude, danh tính nằm trong file thứ hai cạnh thư mục cấu hình;
có thể đọc `accountUuid` từ đó nếu nguồn là `.credentials.json` trong một thư mục cấu hình Claude, nhưng hai file có thể lệch
nhau (ví dụ đăng nhập lại chỉ ghi một file trước). Thử nghiệm động phải kiểm hai file có luôn đổi cùng nhau không.

### S5: cách vendor ghi credential và khóa

**Claude Code** (module `secureStorage`, nhánh plaintext trên Linux):

- Đường dẫn: `F$()` là thư mục cấu hình (`$CLAUDE_CONFIG_DIR` hoặc `~/.claude`), file `.credentials.json`, quyền `0600`.
- Khóa ghi giữa các process: `proper-lockfile` trên đường dẫn `<config dir>/.storage-write`, tức **thư mục khóa**
  `<config dir>/.storage-write.lock` tạo bằng `mkdir`, với `realpath: false`, `stale: 15000` ms, thử lại 10 lần (100–1000 ms).
  Bên giữ khóa làm mới mtime định kỳ; khóa coi là stale khi mtime cũ hơn 15 giây. Trong một process còn có hàng đợi tuần tự.
- Ghi theo kiểu đọc–sửa–ghi trong khóa: vô hiệu cache, đọc lại file (`readAsyncStrict`), áp hàm cập nhật, rồi mới ghi. Đọc lỗi
  tạm thời thì bỏ ghi.
- Hàm ghi file (`Tce`) có nhánh ghi file tạm rồi rename, và nhánh ghi đè tại chỗ (`O_TRUNC`) làm dự phòng; mở file bằng
  `O_NOFOLLOW`, từ chối symlink và file có nhiều hard link. Nhánh nào được dùng cho credential cần xác nhận động.
- Phát hiện thay đổi từ bên ngoài bằng mtime/phiên bản của `.credentials.json` rồi đọc lại.

**Codex CLI:**

- `$CODEX_HOME/auth.json` (`0600`) và file khóa rỗng `$CODEX_HOME/auth.lock` (`0644`) tồn tại trên máy này.
- Có "guarded reload": trước khi làm mới, Codex đọc lại `auth.json`; nếu đã đổi thì bỏ làm mới ("Skipping token refresh because
  auth changed after guarded reload").
- Kiểu khóa trên `auth.lock` (`flock`, `fcntl` hay khác) không đọc được từ chuỗi; cần `strace`/`/proc/locks` khi chạy.

Hệ quả cho R-13: cả hai vendor **có** khóa riêng mà cusr có thể tham gia, nhưng là hai giao thức khác nhau:

| Vendor | Khóa cusr phải lấy | Ghi chú |
| --- | --- | --- |
| Claude | Thư mục `<thư mục chứa nguồn>/.storage-write.lock` theo đúng quy ước `proper-lockfile` (mkdir, làm mới mtime khi giữ, stale 15 giây) | Giao thức stale theo mtime của `proper-lockfile` có cửa sổ tranh chấp riêng khi hai bên cùng chiếm khóa stale; đó là giới hạn của chính Claude Code, cusr chỉ không được làm tệ hơn |
| Codex | Khóa trên `<thư mục chứa nguồn>/auth.lock`, kiểu xác định ở thử nghiệm động | Nếu là `flock`, Node không có sẵn; dùng `flock(1)` của util-linux như R-13 đã nêu |

Khóa SQLite của cusr (R-13) vẫn cần để tuần tự hóa các writer của cusr, nhưng không thay được khóa vendor: `fcntl` của SQLite
và `flock` không loại trừ nhau trên Linux.

### S2: làm mới đồng thời

- Codex phân biệt lỗi refresh token "has expired", "**was already used**" và "was revoked". Refresh token được xoay vòng và
  có phát hiện dùng lại: hai attempt chạy song song với cùng một bản sao `auth.json` trong hai private home riêng (không chung
  khóa, không thấy nhau) sẽ cùng làm mới từ một refresh token, và bên thứ hai **nhiều khả năng bị từ chối**. Nếu nhà cung cấp
  còn thu hồi cả họ token khi phát hiện dùng lại, cả hai bên đều mất đăng nhập.
- Claude: chuỗi tĩnh chưa cho biết refresh token có xoay hay có phát hiện dùng lại. `refreshTokenExpiresAt` cho thấy refresh
  token có hạn riêng.

Hệ quả: rủi ro "cả hai bản đều chết khi làm mới đồng thời" ở plan là có thật với Codex. Phương án dự phòng ở R-12 (xếp attempt
cùng tài khoản nối tiếp, sửa FR-020) có thể trở thành bắt buộc cho Codex.

### S1, S4

Chưa có kết luận tĩnh:

- **S1:** cusr hiện chép session giữa private home mà không chép auth; chưa rõ Claude có kiểm session thuộc tài khoản nào khi
  `--resume`.
- **S4:** Codex có `codex login` và `codex login --device-auth`; Claude đăng nhập qua `/login` trong phiên tương tác. Cả hai cần
  kiểm khi `HOME`/`CODEX_HOME` trỏ vào thư mục trống.

## Phần 2a — Thử nghiệm động không cần tài khoản (đã chạy 2026-11-04)

Chạy trên bản credential **giả** trong thư mục tạm (`HOME`/`CODEX_HOME` riêng), lệnh `logout` vì nó đi qua cùng đường ghi có
khóa mà không cần mạng hay tài khoản thật. Chưa quan sát đường ghi khi làm mới token; phần đó cần tài khoản (Phần 2b).

| Thử nghiệm | Kết quả |
| --- | --- |
| Codex: `strace` khi `codex logout` | Mở `$CODEX_HOME/auth.lock` (`O_RDWR\|O_CREAT`) và gọi `flock(fd, LOCK_EX)` quanh việc đổi `auth.json`. **Kiểu khóa là `flock`.** |
| Codex: giữ `flock -x auth.lock` 8 giây rồi chạy `codex logout` | Codex chờ tới khi khóa được nhả; trong lúc chờ `auth.json` không bị đụng tới |
| Claude: `strace` khi `claude auth logout` | `mkdir <config dir>/.storage-write.lock` → đổi `.credentials.json` → `rmdir` khóa. **Kiểu khóa là thư mục `proper-lockfile`.** |
| Claude: giữ thư mục khóa, `touch` mỗi 1–2 giây | Claude thử `mkdir` liên tục (22 lần trong trace), rồi **sau khoảng 16 giây vẫn ghi dù khóa còn bị giữ và mtime vẫn mới**. Giữ dưới khoảng 15 giây thì Claude chờ đúng tới khi khóa được nhả |

Kết luận tạm cho S5 (phần khóa, chưa gồm Orca):

- cusr **tham gia được** khóa của cả hai vendor: `flock` trên `auth.lock` (qua `flock(1)` vì Node không có `flock`), và thư mục
  `.storage-write.lock` theo quy ước `proper-lockfile` của Claude.
- Khóa của Claude chỉ loại trừ trong khoảng chờ có giới hạn (~15–16 giây). cusr phải giữ khóa này ngắn hơn nhiều (đoạn kiểm
  digest và rename chỉ tốn mili giây) và không được giữ nó trong lúc chờ khóa khác quá lâu. Thứ tự lấy khóa: khóa SQLite của
  cusr trước (chờ được lâu), khóa vendor sau và nhả ngay sau rename.
- Khóa stale của Claude (mtime cũ hơn 15 giây) được Claude tự chiếm lại; cusr theo cùng quy tắc, và vì các writer cusr đã tuần
  tự qua khóa SQLite nên chỉ có tối đa một writer cusr tranh chiếm khóa stale cùng lúc.
- Orca chưa kiểm: nếu Orca chỉ gọi CLI vendor để làm mới token thì nó dùng chính các khóa này; nếu Orca tự ghi file thì cần
  xem mã của Orca.

## Phần 2b — Thử nghiệm động với tài khoản phụ (đã chạy 2026-11-04)

Chủ dự án đăng nhập tài khoản phụ vào `~/cusr-spike/{claude-a,claude-b,codex-a}`. Mọi thử nghiệm chạy trên bản sao trong thư
mục tạm; token chỉ được ghi dưới dạng mã băm 8 ký tự. Lệnh gọi model: `claude -p … --model haiku`, `codex exec` với prompt
một dòng. Cuối buổi, bản credential mới nhất còn dùng được được ghi về nguồn của `claude-a` và `codex-a` (dưới khóa vendor) và
các bản sao chứa token đã bị xóa.

| Spike | Thử nghiệm | Kết quả |
| --- | --- | --- |
| S4 | `HOME=<dir> claude auth login`; `CODEX_HOME=<dir> codex login --device-auth` | **Đạt.** Credential nằm đúng `<dir>/.claude/.credentials.json` (+ `<dir>/.claude.json`) và `<dir>/auth.json`, quyền `0600` |
| S3 | So `accountUuid` (Claude, trong `.claude.json`) và `tokens.account_id` (Codex) giữa các thư mục, dưới dạng mã băm | **Đạt một phần.** Hai mã đọc được và phân biệt được tài khoản. `claude-b` hóa ra **cùng `accountUuid` với tài khoản Claude chính** (đăng nhập nhầm phiên trình duyệt): đúng trường hợp cảnh báo trùng danh tính của FR-009. Chưa kiểm `.claude.json` và `.credentials.json` có luôn đổi cùng nhau khi đăng nhập lại sang tài khoản khác |
| S2/S5 Claude, làm mới một lần | Đặt `expiresAt` về quá khứ trong bản sao, chạy một lệnh, `strace` | Làm mới thành công; **refresh token được xoay**. Đường ghi: `mkdir .storage-write.lock` → mở `.credentials.json.tmp.<hex>` bằng `O_CREAT\|O_EXCL`, `0600` → `rename` đè nguồn → `rmdir` khóa. Ghi nguyên tử |
| S2 Claude, làm mới đồng thời | Hai bản sao giống nhau, cùng hết hạn, chạy song song | **Một bên thành công, một bên thất bại** với "OAuth session expired and could not be refreshed", và bên thua **ghi đè credential trong home của nó thành token rỗng** |
| S2 Claude, dùng lại refresh token đã tiêu | Bản sao gốc (refresh token đã bị xoay) | Bị từ chối như trên. **Không thu hồi cả họ token:** nhánh mới nhất vẫn làm mới được sau đó |
| S2/S5 Codex, làm mới một lần | Thay `access_token` bằng giá trị không hợp lệ để Codex phải phục hồi qua làm mới (`last_refresh` cũ không đủ để ép làm mới) | Làm mới thành công; **refresh token được xoay**. Đường ghi: `flock(auth.lock, LOCK_EX)` → mở `auth.json` bằng `O_WRONLY\|O_CREAT\|O_TRUNC` và **ghi đè tại chỗ**, không rename |
| S2 Codex, làm mới đồng thời và dùng lại | Hai bản sao giống nhau chạy song song; sau đó làm mới tiếp từng nhánh; rồi dùng lại refresh token gốc đã tiêu sau khoảng 4 phút | **Mọi lần đều thành công**, mỗi lần nhận refresh token mới khác nhau; không nhánh nào bị thu hồi trong khoảng đã thử. Chuỗi "refresh token was already used" có trong binary nên máy chủ có thể áp quy tắc này sau một khoảng ân hạn lớn hơn 4 phút |
| S1 | Resume session của tài khoản A trên tài khoản B | **Chưa chạy:** cần hai tài khoản Claude phụ khác danh tính; `claude-b` là tài khoản chính nên không dùng |

## Phần 2c — Orca (phân tích mã nguồn, 2026-11-04)

Orca không cài trên máy này nên phân tích mã nguồn `stablyai/orca` tại commit `f3319752` (2026-11-03). Đường dẫn dưới đây
tương đối với `src/main/`. Chưa chạy Orca thật.

| Câu hỏi | Kết quả |
| --- | --- |
| Mỗi tài khoản nằm ở đâu (Linux) | Claude: một `CLAUDE_CONFIG_DIR` cho mỗi tài khoản tại `~/.config/orca/claude-profiles/<id>/home` (`claude-accounts/claude-profile-paths.ts:62-67`); nguồn để trỏ tới là `home/.credentials.json`, danh tính ở `home/.claude.json`. Codex: `CODEX_HOME` riêng tại `~/.config/orca/codex-accounts/<uuid>/home` (`codex-accounts/codex-managed-home-lifecycle.ts`); nguồn là `home/auth.json`. Trong WSL guest: `~/.local/share/orca/…` |
| Orca chạy agent thế nào | Đặt `CLAUDE_CONFIG_DIR` hoặc `CODEX_HOME` trỏ thẳng vào thư mục của tài khoản; không chép credential, không đổi `HOME`. Đổi tài khoản chỉ đổi biến môi trường và file con trỏ, **không** ghi đè `~/.claude/.credentials.json` hay `~/.codex/auth.json` |
| Ai ghi `.credentials.json` của Claude | **Chỉ CLI Claude** do Orca chạy (dưới `.storage-write.lock`). Orca chỉ đọc nó để hiện usage và **không tự làm mới token** ("only a user-started Claude process may refresh its login", `rate-limits/claude-active-usage-fetch.ts:14`) |
| Ai ghi `auth.json` của Codex | CLI Codex (dưới `flock auth.lock`), kể cả tiến trình `codex app-server` mà Orca chạy định kỳ để đọc usage. **Ngoài ra Orca tự ghi** `auth.json` khi nhập tài khoản từ một thư mục, khi đăng nhập lại, khi di trú dữ liệu cũ và ở chế độ mirror cũ (chỉ khi người dùng đặt `CODEX_HOME` riêng): ghi tạm rồi `rename` (`codex-accounts/fs-utils.ts:15-23`), hoặc CAS bằng hard link (`writeFileAtomicallyIfUnchanged`), quyền `0600`, **không lấy `flock auth.lock`** |
| Danh tính | Claude: `oauthAccount.emailAddress` và `organizationUuid` trong `.claude.json`. Codex: `tokens.account_id` (hoặc claim `chatgpt_account_id`) và email trong `id_token` |

Kết luận S5 cho Orca:

- **Claude qua Orca: đạt.** Writer duy nhất là CLI Claude, nên khóa `.storage-write.lock` đủ phối hợp.
- **Codex qua Orca: đạt có giới hạn.** Mọi lần làm mới token đi qua CLI Codex và `flock`. Còn lại các lần Orca tự thay
  `auth.json` khi người dùng nhập hoặc đăng nhập lại tài khoản: chúng không lấy `flock`, nên nếu xảy ra đúng trong vài mili
  giây giữa bước cusr đọc digest và bước `rename`, bản của Orca có thể bị ghi đè. Đây là thao tác do người dùng chủ động và
  hiếm; bản bị mất là một lần đăng nhập mới, người dùng thấy ngay và đăng nhập lại được. Muốn giữ FR-023 tuyệt đối với trường
  hợp này thì phải sửa ở phía Orca (lấy `flock auth.lock` khi ghi). Cần chủ dự án quyết định chấp nhận giới hạn này hay không.

## Kết luận và ảnh hưởng tới plan

**Quyết định sau spike (chủ dự án, 2026-11-04):** cusr chỉ dùng tài khoản do chính nó đăng nhập vào thư mục nó quản lý và
chỉ ghi vào đó; không dùng chung credential với phiên tương tác hay Orca. Vì vậy các dòng về khóa vendor ở nguồn và giới hạn
khi Orca tự ghi `auth.json` dưới đây chỉ còn là bối cảnh: chúng là lý do của quyết định, không còn là việc phải làm.


| Mục | Kết luận | Thay đổi đề xuất |
| --- | --- | --- |
| R-13 (S5) | **Đạt cho Claude và Codex; Orca đạt với Claude, đạt có giới hạn với Codex** (Phần 2c). Cả hai CLI ghi credential dưới khóa riêng mà cusr tham gia được và chúng tôn trọng: thư mục `proper-lockfile` `.storage-write.lock` (Claude, chờ tối đa ~16 giây) và `flock` trên `auth.lock` (Codex) | Lấy khóa vendor ở thư mục nguồn quanh bước đọc digest và ghi; giữ ngắn; khóa SQLite của cusr vẫn tuần tự các writer cusr. Hướng dự phòng 1–3 của R-13 không cần cho hai vendor này |
| R-06 | Codex ghi đè tại chỗ; Claude ghi bằng rename | cusr phải **đọc** nguồn trong khi giữ khóa vendor (nếu không, có thể đọc file Codex đang ghi dở); cusr vẫn ghi bằng tmp + rename trong khóa |
| R-06 / FR-024 | Bên thua khi làm mới đồng thời (Claude) để lại credential **rỗng** trong private home | `validate` của adapter phải từ chối token rỗng hoặc `expiresAt` không hợp lệ; trường hợp này là `rejected: format`, không ghi về nguồn |
| FR-018 | Với Claude, attempt thua lỗi auth **ngay lúc làm mới**, thường trước khi attempt thắng kết thúc và ghi về nguồn. Nếu chỉ ghi về nguồn lúc attempt kết thúc, bước kiểm "nguồn đã đổi" của FR-018 sẽ thấy nguồn chưa đổi và đánh dấu nhầm tài khoản lỗi đăng nhập | Runner **ghi về nguồn ngay khi credential trong private home đổi** (theo dõi file, cùng thủ tục khóa + CAS), không chỉ lúc kết thúc; daemon xét `source_changed` khi xử lý lỗi auth, sau khi attempt kia đã có cơ hội ghi. Cần thêm câu này vào FR-022 hoặc plan |
| FR-020 | Làm mới đồng thời không làm chết cả hai bên với cả hai vendor; Claude chỉ làm hỏng một bên và bên đó được FR-018 cứu nếu có ghi sớm như trên | **Không** cần xếp nối tiếp attempt cùng tài khoản; giữ FR-020 |
| R-07 | Codex: `tokens.account_id` trong nguồn. Claude: `oauthAccount.accountUuid` trong `.claude.json` cạnh thư mục cấu hình | Dùng hai trường này; với Claude, nguồn phải là thư mục cấu hình (có cả `.credentials.json` và `.claude.json`). Kiểm đồng bộ hai file khi đăng nhập lại vẫn còn mở |
| R-08 (S4) | Login vào thư mục chỉ định hoạt động với `claude auth login` và `codex login --device-auth` | Chốt hai lệnh này cho `cusr account add --login` |
| R-02 (S1) | Chưa có bằng chứng | Giữ phương án dự phòng (session mới qua `resume_fallback`) cho tới khi chạy S1 với hai tài khoản Claude phụ khác danh tính |
