/** Kết thúc mọi `switch` trên union miền; typecheck báo lỗi khi thiếu nhánh (SPEC.md §17.2). */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
