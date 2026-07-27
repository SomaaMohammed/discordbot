export class AsyncWorkTracker {
  private accepting = true;
  private readonly inFlight = new Set<Promise<void>>();

  public get isAccepting(): boolean {
    return this.accepting;
  }

  public get size(): number {
    return this.inFlight.size;
  }

  public run(task: () => Promise<void>): Promise<void> {
    if (!this.accepting) {
      return Promise.resolve();
    }

    const promise = Promise.resolve().then(task);
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  public stopAccepting(): void {
    this.accepting = false;
  }

  public async drain(timeoutMs: number): Promise<boolean> {
    const pending = [...this.inFlight];
    if (pending.length === 0) {
      return true;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const boundedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
    try {
      return await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), boundedTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
