/** Lõi không tự sinh ID: lấy lần lượt từ `envelope.ids`, hết thì từ chối cả quyết định (research R-04). */
export class IdPoolExhausted extends Error {
  override name = 'IdPoolExhausted';
}

export class IdPool {
  private next = 0;
  private readonly ids: readonly string[];

  constructor(ids: readonly string[]) {
    this.ids = ids;
  }

  take(): string {
    const id = this.ids[this.next];
    if (id === undefined)
      throw new IdPoolExhausted(
        `cần ID thứ ${this.next + 1}, phong bì chỉ có ${this.ids.length}`,
      );
    this.next++;
    return id;
  }

  get used(): number {
    return this.next;
  }
}
