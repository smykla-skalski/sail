type Waiter = {
  id: string;
  directory: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  admission?: AbortController;
  reason?: string;
};

export type AdmissionProvider = (
  signal: AbortSignal,
  reason: (value: string) => void,
) => Promise<() => void>;

export class ResourceQueue {
  private active = new Set<string>();
  private waiters: Waiter[] = [];
  private limit: number;
  private blockedReason: string | null;
  private directoryReasons = new Map<string, string>();
  private onEnqueue?: () => void;
  private listeners = new Set<() => void>();
  private admission: AdmissionProvider | null = null;
  private leases = new Map<string, () => void>();

  setAdmission(provider: AdmissionProvider | null): void {
    this.admission = provider;
    for (const waiter of this.waiters) {
      waiter.admission?.abort();
      delete waiter.admission;
      delete waiter.reason;
    }
    this.drain();
    this.emit();
  }

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
    return (
      waiter?.reason ||
      this.blockedReason ||
      (waiter && this.directoryReasons.get(waiter.directory)) ||
      null
    );
  }

  get status() {
    return { active: this.active.size, waiting: this.waiters.length, limit: this.limit };
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

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  restoreActive(id: string): void {
    if (this.active.has(id)) return;
    this.active.add(id);
    this.emit();
  }

  waitingDirectories(): string[] {
    return this.waiters.map((waiter) => waiter.directory);
  }

  acquire(id: string, directory = ''): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (this.active.has(id) || this.waiters.some((waiter) => waiter.id === id)) {
        reject(new Error('Resource request already exists.'));
        return;
      }
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
    waiter.admission?.abort();
    waiter.reject(new Error('Queued work was cancelled.'));
    this.drain();
    this.emit();
    return true;
  }

  release(id: string): boolean {
    if (!this.active.delete(id)) return false;
    this.leases.get(id)?.();
    this.leases.delete(id);
    this.drain();
    this.emit();
    return true;
  }

  private drain(): void {
    if (this.admission) {
      this.drainAdmission();
      return;
    }
    while (!this.blockedReason && this.active.size < this.limit && this.waiters.length) {
      const index = this.waiters.findIndex(
        (waiter) => !this.directoryReasons.has(waiter.directory),
      );
      if (index < 0) break;
      const [waiter] = this.waiters.splice(index, 1);
      this.active.add(waiter.id);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.release(waiter.id);
      });
    }
  }

  private drainAdmission(): void {
    const provider = this.admission;
    if (!provider) return;
    let reserved = this.active.size + this.waiters.filter((waiter) => waiter.admission).length;
    for (const waiter of this.waiters) {
      if (reserved >= this.limit) break;
      if (waiter.admission) continue;
      reserved++;
      const controller = new AbortController();
      waiter.admission = controller;
      waiter.reason = 'Checking Reef admission…';
      void provider(controller.signal, (reason) => {
        if (waiter.admission !== controller || controller.signal.aborted) return;
        waiter.reason = reason;
        this.emit();
      })
        .then((release) => {
          if (
            controller.signal.aborted ||
            waiter.admission !== controller ||
            !this.waiters.includes(waiter)
          ) {
            release();
            return null;
          }
          if (this.active.size >= this.limit) {
            release();
            delete waiter.admission;
            delete waiter.reason;
            this.drain();
            this.emit();
            return null;
          }
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          this.active.add(waiter.id);
          this.leases.set(waiter.id, release);
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            this.release(waiter.id);
          });
          this.emit();
          return null;
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || waiter.admission !== controller) return;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
          this.drain();
          this.emit();
        });
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
