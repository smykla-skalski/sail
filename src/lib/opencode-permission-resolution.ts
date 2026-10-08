import type { PermissionRequest } from '@opencode/client';

type RejectionRequest = {
  selected: PermissionRequest;
  list: () => Promise<PermissionRequest[]>;
  validate?: (requests: PermissionRequest[]) => Promise<boolean>;
  reply: () => Promise<void>;
  record: (request: PermissionRequest) => void;
};

type AutomaticResolutionRequest = {
  selected: PermissionRequest;
  decision: Exclude<PermissionReply, 'reject'>;
  reply: () => Promise<void>;
  record: (request: PermissionRequest, reply: PermissionReply) => void;
};

type PermissionReply = 'once' | 'always' | 'reject';

type Settlement<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function settlement<T>(): Settlement<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type ActiveRejection = {
  requests: Map<string, PermissionRequest>;
  awaitingSettledIDs: Set<string>;
  unresolvedRejectedIDs: Set<string>;
  rejectedIDs: Set<string>;
  settledRejectedIDs: Set<string>;
  recordedIDs: Set<string>;
  replyComplete: boolean;
  inventoryRecorded: boolean;
  inventoryRevision: number;
  record: (request: PermissionRequest) => void;
  settlement: Settlement<PermissionRequest[]>;
};

type RecentRejection = Pick<ActiveRejection, 'rejectedIDs' | 'recordedIDs' | 'record'>;

type AmbiguousReply = {
  request: PermissionRequest;
  record: (request: PermissionRequest) => void;
};

type ObservedPermission = {
  request: PermissionRequest;
  record?: (request: PermissionRequest) => void;
  recordAutomatic?: (request: PermissionRequest, reply: PermissionReply) => void;
};

export class OpenCodePermissionRejectionCoordinator {
  readonly #observed = new Map<string, Map<string, ObservedPermission>>();
  readonly #active = new Map<string, ActiveRejection>();
  readonly #recent = new Map<string, RecentRejection>();
  readonly #nonRejected = new Map<string, Set<string>>();
  readonly #inFlight = new Map<string, Promise<PermissionRequest[] | null>>();
  readonly #ambiguousReplies = new Map<string, Map<string, AmbiguousReply>>();
  readonly #maxSessions: number;
  readonly #maxRequests: number;
  readonly #ambiguousSessions = new Set<string>();
  #allSessionsAmbiguous = false;

  constructor(limits: { maxSessions?: number; maxRequests?: number } = {}) {
    this.#maxSessions = Math.max(1, limits.maxSessions ?? 128);
    this.#maxRequests = Math.max(1, limits.maxRequests ?? 512);
  }

  observe(request: PermissionRequest): void {
    let session = this.#observed.get(request.sessionID);
    if (!session) this.#observed.set(request.sessionID, (session = new Map()));
    const previous = session.get(request.id);
    const inventoryChanged =
      !previous || JSON.stringify(previous.request) !== JSON.stringify(request);
    session.set(request.id, {
      request,
      record: previous?.record,
      recordAutomatic: previous?.recordAutomatic,
    });
    const active = this.#active.get(request.sessionID);
    const wasNotRejected = this.#wasNotRejected(request.sessionID, request.id);
    if (inventoryChanged && active && !wasNotRejected && !active.settledRejectedIDs.has(request.id))
      active.inventoryRevision++;
    if (wasNotRejected) {
      this.#forgetObserved(request.sessionID, request.id);
      return;
    }
    if (active?.rejectedIDs.has(request.id)) {
      active.requests.set(request.id, request);
      active.unresolvedRejectedIDs.delete(request.id);
      this.#record(active, request);
      this.#forgetObserved(request.sessionID, request.id);
      this.#finish(request.sessionID, active);
      return;
    }
    const recent = this.#recent.get(request.sessionID);
    if (recent?.rejectedIDs.has(request.id)) this.#recordRecent(request.sessionID, recent, request);
  }

  settle(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    recordEvicted?: (request: PermissionRequest) => void,
  ): void {
    const automaticObserved = this.#observed.get(sessionID)?.get(requestID);
    automaticObserved?.recordAutomatic?.(automaticObserved.request, reply);
    const ambiguousReply = this.#ambiguousReplies.get(sessionID)?.get(requestID);
    if (ambiguousReply) {
      this.#forgetAmbiguousReply(sessionID, requestID);
      if (reply === 'reject') ambiguousReply.record(ambiguousReply.request);
      else this.#rememberNotRejected(sessionID, requestID);
      this.#forgetObserved(sessionID, requestID);
      return;
    }
    const active = this.#active.get(sessionID);
    if (!active) {
      if (reply !== 'reject') this.#rememberNotRejected(sessionID, requestID);
      else {
        const recent = this.#recent.get(sessionID);
        if (recent) {
          this.#boundedAdd(recent.rejectedIDs, requestID);
          const observed = this.#observed.get(sessionID)?.get(requestID);
          if (observed) this.#recordRecent(sessionID, recent, observed.request);
        } else if (this.#inventoryAmbiguous(sessionID)) {
          const observed = this.#observed.get(sessionID)?.get(requestID);
          if (observed?.record) observed.record(observed.request);
          else if (observed && recordEvicted) recordEvicted(observed.request);
        }
      }
      this.#forgetObserved(sessionID, requestID);
      return;
    }
    if (reply === 'reject') {
      active.rejectedIDs.add(requestID);
      active.settledRejectedIDs.add(requestID);
      const observed = this.#observed.get(sessionID)?.get(requestID);
      const request = observed?.request ?? active.requests.get(requestID);
      active.awaitingSettledIDs.delete(requestID);
      if (request) {
        active.requests.set(requestID, request);
        this.#record(active, request);
        this.#forgetObserved(sessionID, requestID);
      } else active.unresolvedRejectedIDs.add(requestID);
      this.#finish(sessionID, active);
      return;
    }
    this.#rememberNotRejected(sessionID, requestID);
    active.rejectedIDs.delete(requestID);
    active.awaitingSettledIDs.delete(requestID);
    active.unresolvedRejectedIDs.delete(requestID);
    active.requests.delete(requestID);
    this.#forgetObserved(sessionID, requestID);
    this.#finish(sessionID, active);
  }

  async resolveAutomatically(request: AutomaticResolutionRequest): Promise<void> {
    let session = this.#observed.get(request.selected.sessionID);
    if (!session) this.#observed.set(request.selected.sessionID, (session = new Map()));
    const observed = session.get(request.selected.id);
    session.set(request.selected.id, {
      request: request.selected,
      record: observed?.record,
      recordAutomatic: request.record,
    });
    await request.reply();
    this.settle(request.selected.sessionID, request.selected.id, request.decision);
    const unresolved = this.#observed.get(request.selected.sessionID)?.get(request.selected.id);
    if (unresolved?.recordAutomatic !== request.record) return;
    request.record(unresolved.request, request.decision);
    this.#forgetObserved(request.selected.sessionID, request.selected.id);
  }

  async resolvePendingAutomatically(
    request: AutomaticResolutionRequest,
    isMissing: (cause: unknown) => boolean,
  ): Promise<boolean> {
    try {
      await this.resolveAutomatically(request);
      return true;
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      return false;
    }
  }

  async reconcile(list: (sessionID: string) => Promise<PermissionRequest[]>): Promise<void> {
    await Promise.all(
      [...this.#active.keys()].map(async (sessionID) => {
        const pending = await list(sessionID);
        this.#reconcile(sessionID, pending);
      }),
    );
  }

  reject(request: RejectionRequest): Promise<PermissionRequest[] | null> {
    const sessionID = request.selected.sessionID;
    const existing = this.#inFlight.get(sessionID);
    if (existing) return existing;
    const resolution = this.#reject(request).finally(() => {
      this.#inFlight.delete(sessionID);
    });
    this.#inFlight.set(sessionID, resolution);
    return resolution;
  }

  async #reject(request: RejectionRequest): Promise<PermissionRequest[] | null> {
    const sessionID = request.selected.sessionID;
    const active: ActiveRejection = {
      requests: new Map([[request.selected.id, request.selected]]),
      awaitingSettledIDs: new Set([request.selected.id]),
      unresolvedRejectedIDs: new Set(),
      rejectedIDs: new Set([request.selected.id]),
      settledRejectedIDs: new Set(),
      recordedIDs: new Set(),
      replyComplete: false,
      inventoryRecorded: false,
      inventoryRevision: 0,
      record: request.record,
      settlement: settlement<PermissionRequest[]>(),
    };
    this.#recent.delete(sessionID);
    this.#active.set(sessionID, active);
    const inventoryRevision = active.inventoryRevision;
    try {
      const pendingRequests = await request.list();
      if (request.validate && !(await request.validate(pendingRequests))) {
        if (this.#active.get(sessionID) === active) this.#active.delete(sessionID);
        return null;
      }
      for (const pending of pendingRequests) {
        if (pending.sessionID !== sessionID || this.#wasNotRejected(sessionID, pending.id))
          continue;
        if (this.#inventoryAmbiguous(sessionID) && !active.rejectedIDs.has(pending.id)) continue;
        active.requests.set(pending.id, pending);
        if (!active.settledRejectedIDs.has(pending.id)) active.awaitingSettledIDs.add(pending.id);
      }
      if (active.inventoryRevision !== inventoryRevision) {
        if (this.#active.get(sessionID) === active) this.#active.delete(sessionID);
        return null;
      }
    } catch (cause) {
      if (this.#active.get(sessionID) === active) this.#active.delete(sessionID);
      throw cause;
    }
    try {
      await request.reply();
    } catch (cause) {
      active.replyComplete = true;
      active.inventoryRecorded = true;
      for (const requestID of active.settledRejectedIDs) {
        const settled = active.requests.get(requestID);
        if (settled) this.#record(active, settled);
      }
      for (const requestID of active.awaitingSettledIDs) {
        const pending = active.requests.get(requestID);
        if (pending) this.#rememberAmbiguousReply(sessionID, pending, active.record);
      }
      if (this.#active.get(sessionID) === active) this.#active.delete(sessionID);
      this.#archive(sessionID, active, active.settledRejectedIDs);
      throw cause;
    }
    active.replyComplete = true;
    active.inventoryRecorded = true;
    for (const requestID of active.settledRejectedIDs) {
      const settled = active.requests.get(requestID);
      if (settled) this.#record(active, settled);
    }
    this.#finish(sessionID, active);
    if (this.#active.get(sessionID) === active)
      try {
        this.#reconcile(sessionID, await request.list());
      } catch {
        // Reconnect reconciliation handles an unavailable permission inventory.
      }
    return active.settlement.promise;
  }

  #reconcile(sessionID: string, pending: PermissionRequest[]): void {
    const active = this.#active.get(sessionID);
    if (!active?.replyComplete) return;
    const pendingIDs = new Set(
      pending.filter((request) => request.sessionID === sessionID).map((request) => request.id),
    );
    for (const requestID of active.awaitingSettledIDs) {
      if (pendingIDs.has(requestID)) continue;
      active.awaitingSettledIDs.delete(requestID);
      active.rejectedIDs.add(requestID);
      active.settledRejectedIDs.add(requestID);
      const request = active.requests.get(requestID);
      if (request) this.#record(active, request);
      else active.unresolvedRejectedIDs.add(requestID);
    }
    this.#finish(sessionID, active);
  }

  #record(active: ActiveRejection, request: PermissionRequest): void {
    if (
      !active.replyComplete ||
      !active.inventoryRecorded ||
      this.#wasNotRejected(request.sessionID, request.id)
    )
      return;
    if (active.recordedIDs.has(request.id)) return;
    active.recordedIDs.add(request.id);
    active.record(request);
  }

  #finish(sessionID: string, active: ActiveRejection): void {
    if (
      active.replyComplete &&
      active.inventoryRecorded &&
      active.awaitingSettledIDs.size === 0 &&
      active.unresolvedRejectedIDs.size === 0 &&
      this.#active.get(sessionID) === active
    ) {
      this.#active.delete(sessionID);
      this.#archive(sessionID, active, active.rejectedIDs);
      active.settlement.resolve(
        [...active.requests.values()].filter((request) => active.rejectedIDs.has(request.id)),
      );
    }
  }

  #recordRecent(sessionID: string, recent: RecentRejection, request: PermissionRequest): void {
    if (this.#wasNotRejected(sessionID, request.id) || recent.recordedIDs.has(request.id)) return;
    this.#boundedAdd(recent.recordedIDs, request.id);
    recent.record(request);
    this.#forgetObserved(sessionID, request.id);
  }

  #rememberNotRejected(sessionID: string, requestID: string): void {
    let requests = this.#nonRejected.get(sessionID);
    if (!requests) {
      requests = new Set();
      while (this.#nonRejected.size >= this.#maxSessions) {
        const expiredSessionID = this.#nonRejected.keys().next().value!;
        this.#nonRejected.delete(expiredSessionID);
        this.#markInventoryAmbiguous(expiredSessionID);
      }
      this.#nonRejected.set(sessionID, requests);
    } else {
      this.#nonRejected.delete(sessionID);
      this.#nonRejected.set(sessionID, requests);
    }
    if (!requests.has(requestID) && requests.size >= this.#maxRequests) {
      requests.delete(requests.values().next().value!);
      this.#markInventoryAmbiguous(sessionID);
    }
    requests.add(requestID);
  }

  #wasNotRejected(sessionID: string, requestID: string): boolean {
    return this.#nonRejected.get(sessionID)?.has(requestID) ?? false;
  }

  #markInventoryAmbiguous(sessionID: string): void {
    if (this.#allSessionsAmbiguous) return;
    if (
      !this.#ambiguousSessions.has(sessionID) &&
      this.#ambiguousSessions.size >= this.#maxSessions
    ) {
      this.#ambiguousSessions.clear();
      this.#allSessionsAmbiguous = true;
      return;
    }
    this.#ambiguousSessions.delete(sessionID);
    this.#ambiguousSessions.add(sessionID);
  }

  #inventoryAmbiguous(sessionID: string): boolean {
    return this.#allSessionsAmbiguous || this.#ambiguousSessions.has(sessionID);
  }

  #rememberAmbiguousReply(
    sessionID: string,
    request: PermissionRequest,
    record: (request: PermissionRequest) => void,
  ): void {
    let requests = this.#ambiguousReplies.get(sessionID);
    if (!requests) {
      requests = new Map();
      while (this.#ambiguousReplies.size >= this.#maxSessions) {
        const expiredSessionID = this.#ambiguousReplies.keys().next().value!;
        const expired = this.#ambiguousReplies.get(expiredSessionID)!;
        for (const ambiguous of expired.values())
          this.#retainObserved(ambiguous.request, ambiguous.record);
        this.#ambiguousReplies.delete(expiredSessionID);
        this.#markInventoryAmbiguous(expiredSessionID);
      }
      this.#ambiguousReplies.set(sessionID, requests);
    }
    if (!requests.has(request.id) && requests.size >= this.#maxRequests) {
      const expiredRequestID = requests.keys().next().value!;
      const expired = requests.get(expiredRequestID)!;
      this.#retainObserved(expired.request, expired.record);
      requests.delete(expiredRequestID);
      this.#markInventoryAmbiguous(sessionID);
    }
    requests.set(request.id, { request, record });
  }

  #retainObserved(request: PermissionRequest, record: (request: PermissionRequest) => void): void {
    let requests = this.#observed.get(request.sessionID);
    if (!requests) this.#observed.set(request.sessionID, (requests = new Map()));
    requests.set(request.id, {
      request,
      record,
      recordAutomatic: requests.get(request.id)?.recordAutomatic,
    });
  }

  #forgetAmbiguousReply(sessionID: string, requestID: string): void {
    const requests = this.#ambiguousReplies.get(sessionID);
    requests?.delete(requestID);
    if (requests?.size === 0) this.#ambiguousReplies.delete(sessionID);
  }

  #archive(sessionID: string, active: ActiveRejection, rejectedIDs: Iterable<string>): void {
    const recent: RecentRejection = {
      rejectedIDs: new Set([...rejectedIDs].slice(-this.#maxRequests)),
      recordedIDs: new Set([...active.recordedIDs].slice(-this.#maxRequests)),
      record: active.record,
    };
    this.#setBounded(this.#recent, sessionID, recent);
  }

  #forgetObserved(sessionID: string, requestID: string): void {
    const requests = this.#observed.get(sessionID);
    requests?.delete(requestID);
    if (requests?.size === 0) this.#observed.delete(sessionID);
  }

  #boundedAdd(values: Set<string>, value: string): void {
    values.delete(value);
    values.add(value);
    while (values.size > this.#maxRequests) values.delete(values.values().next().value!);
  }

  #setBounded<T>(map: Map<string, T>, sessionID: string, value: T): void {
    map.delete(sessionID);
    map.set(sessionID, value);
    while (map.size > this.#maxSessions) map.delete(map.keys().next().value!);
  }
}

export const openCodePermissionRejections = new OpenCodePermissionRejectionCoordinator();
