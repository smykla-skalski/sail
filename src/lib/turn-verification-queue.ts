/** Coalesce overlapping requests for one turn and verify again after the active pass settles. */
export function createTurnVerificationQueue() {
  const active = new Map<string, { rerun: boolean; finished: Promise<void> }>();

  return (key: string, verify: () => Promise<void>): Promise<void> => {
    const current = active.get(key);
    if (current) {
      current.rerun = true;
      return current.finished;
    }

    let resolveFinished!: () => void;
    let rejectFinished!: (reason: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const entry = { rerun: false, finished };
    active.set(key, entry);
    const drain = async (): Promise<void> => {
      entry.rerun = false;
      try {
        await verify();
      } catch (cause) {
        active.delete(key);
        throw cause;
      }
      if (entry.rerun) return drain();
      active.delete(key);
    };
    void drain().then(resolveFinished, rejectFinished);
    return finished;
  };
}
