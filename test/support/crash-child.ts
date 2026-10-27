/**
 * Tiến trình con cho test ngắt tiến trình (R-08), chạy bằng `node test/support/crash-child.ts`:
 *
 * - `apply <db> <ops.json>`: mở kho (đọc `CUSR_CRASH_AT`, `CUSR_CRASH_AFTER`), áp lần lượt các thao tác
 *   trong file JSON rồi thoát 0. Hook crash gửi `SIGKILL` cho chính tiến trình tại điểm đã chọn.
 * - `hold <db>`: mở kho, in `ready` rồi giữ khoá ghi tới khi bị giết.
 */
import { readFileSync } from 'node:fs';
import { openStore } from '../../src/store/index.ts';
import { applyOp, type StoreOp } from './store-driver.ts';

const [mode, db, opsFile] = process.argv.slice(2);
if (db === undefined) throw new Error('thiếu đường dẫn DB');

const opened = openStore(db, { busyTimeoutMs: 200 });
if (!opened.ok) {
  process.stdout.write(`open_failed ${opened.error.code}\n`);
  process.exit(3);
}
const store = opened.value;

if (mode === 'hold') {
  process.stdout.write('ready\n');
  // Closure giữ tham chiếu tới kho: không có nó V8 thu gom kết nối và khoá ghi bị nhả.
  setInterval(() => void store, 1_000);
} else if (mode === 'apply') {
  if (opsFile === undefined) throw new Error('thiếu file thao tác');
  const ops = JSON.parse(readFileSync(opsFile, 'utf8')) as StoreOp[];
  for (const op of ops) applyOp(store, op);
  store.close();
  process.stdout.write('done\n');
} else {
  throw new Error(`mode không hợp lệ: ${String(mode)}`);
}
