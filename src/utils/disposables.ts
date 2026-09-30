export interface DisposableLike {
  dispose(): unknown;
}

/** Collects disposables and releases them in reverse order, ignoring individual failures. */
export class DisposableStore implements DisposableLike {
  private items: DisposableLike[] = [];
  private disposed = false;

  add<T extends DisposableLike>(item: T): T {
    if (this.disposed) {
      item.dispose();
    } else {
      this.items.push(item);
    }
    return item;
  }

  dispose(): void {
    this.disposed = true;
    const items = this.items.reverse();
    this.items = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch {
        // Keep releasing the rest.
      }
    }
  }
}
