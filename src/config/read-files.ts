import { readFile } from 'node:fs/promises';
import type { ConfigSource } from './yaml-loader.ts';

/**
 * Shell I/O duy nhất của config (contracts/core-api.md): đọc file cấu hình người dùng và `cusr.yaml`
 * nếu có. Mọi bước sau nhận nội dung đã đọc. `file` giữ đúng đường dẫn caller đưa vào.
 */
export async function readConfigFiles(paths: { user: string; project?: string }): Promise<ConfigSource[]> {
  const list = [paths.user, ...(paths.project !== undefined ? [paths.project] : [])];
  return Promise.all(list.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
}
