/**
 * Consume IDs from envelope.ids; exhaustion rejects the whole decision rather than generating IDs
 * in the core.
 */
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
        `ID ${this.next + 1} is required, but the envelope contains only ${this.ids.length}`,
      );
    this.next++;
    return id;
  }

  get used(): number {
    return this.next;
  }
}
