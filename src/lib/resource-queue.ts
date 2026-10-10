type Waiter = {
  id: string;
  directory: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
};

export class ResourceQueue {
  private active = 0;
  private waiters: Waiter[] = [];
  private limit: number;
  private blockedReason: string | null;
  private directoryReasons = new Map<string, string>();
  private onEnqueue?: () => void;
  private listeners = new Set<() => void>();

  constructor(limit: number, blockedReason: string | null = null, onEnqueue?: () => void) {
    this.limit = limit;
    this.blockedReason = blockedReason;
    this.onEnqueue = onEnqueue;
  }

  get reason(): string | null {
    return this.blockedReason;
  }

  reasonFor(id: string): string | null {
    const waiter = this.waiters.find((entry) => entry.id === id);
    return this.blockedReason || (waiter && this.directoryReasons.get(waiter.directory)) || null;
  }

  get status() {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit };
  }

  setLimit(limit: number): void {
    this.limit = limit;
    this.drain();
    this.emit();
  }

  setBlockedReason(reason: string | null): void {
    if (this.blockedReason === reason) return;
    this.blockedReason = reason;
    this.drain();
    this.emit();
  }

  setDirectoryReasons(reasons: Map<string, string>): void {
    this.directoryReasons = new Map(reasons);
    this.drain();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isQueued(id: string): boolean {
    return this.waiters.some((waiter) => waiter.id === id);
  }

  waitingDirectories(): string[] {
    return this.waiters.map((waiter) => waiter.directory);
  }

  acquire(id: string, directory = ''): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ id, directory, resolve, reject });
      this.onEnqueue?.();
      this.drain();
      this.emit();
    });
  }

  cancel(id: string): boolean {
    const index = this.waiters.findIndex((waiter) => waiter.id === id);
    if (index < 0) return false;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.reject(new Error('Queued work was cancelled.'));
    this.drain();
    this.emit();
    return true;
  }

  private drain(): void {
    while (!this.blockedReason && this.active < this.limit && this.waiters.length) {
      const index = this.waiters.findIndex(
        (waiter) => !this.directoryReasons.has(waiter.directory),
      );
      if (index < 0) break;
      const [waiter] = this.waiters.splice(index, 1);
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
        this.emit();
      });
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
