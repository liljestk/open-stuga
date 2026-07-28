import { randomUUID } from "node:crypto";

import type {
  IntegrationDiscoveryJob,
  IntegrationDiscoveryResult,
} from "@climate-twin/contracts";

interface StoredDiscoveryJob {
  ownerId: string;
  value: IntegrationDiscoveryJob;
}

interface IntegrationDiscoveryJobOptions {
  completedTtlMs?: number;
  id?: () => string;
  now?: () => number;
}

const DEFAULT_COMPLETED_TTL_MS = 60 * 60_000;

function copy(job: IntegrationDiscoveryJob): IntegrationDiscoveryJob {
  return structuredClone(job);
}

function failureMessage(): string {
  return "Device discovery failed. Check the connection and try again.";
}

export class IntegrationDiscoveryJobs {
  readonly #jobs = new Map<string, StoredDiscoveryJob>();
  readonly #latest = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(job: IntegrationDiscoveryJob) => void>>();
  readonly #completedTtlMs: number;
  readonly #id: () => string;
  readonly #now: () => number;
  readonly #cleanupTimer: ReturnType<typeof setInterval>;
  #stopped = false;

  constructor(options: IntegrationDiscoveryJobOptions = {}) {
    this.#completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#cleanupTimer = setInterval(
      () => this.#cleanup(),
      Math.min(60_000, Math.max(1_000, Math.floor(this.#completedTtlMs / 2))),
    );
    this.#cleanupTimer.unref();
  }

  start(
    ownerId: string,
    houseId: string,
    run: () => Promise<IntegrationDiscoveryResult>,
  ): IntegrationDiscoveryJob {
    if (this.#stopped) throw new Error("Device discovery is shutting down");
    this.#cleanup();
    const key = this.#key(ownerId, houseId);
    const previousId = this.#latest.get(key);
    const previous = previousId ? this.#jobs.get(previousId) : undefined;
    if (previous?.value.status === "running") {
      return copy(previous.value);
    }

    const timestamp = new Date(this.#now()).toISOString();
    const value: IntegrationDiscoveryJob = {
      id: this.#id(),
      houseId,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(this.#now() + this.#completedTtlMs).toISOString(),
      result: null,
      error: null,
    };
    const stored = { ownerId, value };
    this.#jobs.set(value.id, stored);
    this.#latest.set(key, value.id);
    this.#publish(stored);
    void this.#execute(stored, run);
    return copy(value);
  }

  get(ownerId: string, id: string): IntegrationDiscoveryJob | null {
    this.#cleanup();
    const stored = this.#jobs.get(id);
    return stored?.ownerId === ownerId ? copy(stored.value) : null;
  }

  latest(ownerId: string, houseId: string): IntegrationDiscoveryJob | null {
    this.#cleanup();
    const id = this.#latest.get(this.#key(ownerId, houseId));
    return id ? this.get(ownerId, id) : null;
  }

  subscribe(ownerId: string, listener: (job: IntegrationDiscoveryJob) => void): () => void {
    const listeners = this.#listeners.get(ownerId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(ownerId);
    };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#cleanupTimer);
    this.#listeners.clear();
  }

  async #execute(
    stored: StoredDiscoveryJob,
    run: () => Promise<IntegrationDiscoveryResult>,
  ): Promise<void> {
    try {
      const result = await run();
      if (stored.value.status === "running") this.#finish(stored, "completed", result, null);
    } catch {
      if (stored.value.status === "running") this.#finish(stored, "failed", null, failureMessage());
    }
  }

  #finish(
    stored: StoredDiscoveryJob,
    status: "completed" | "failed",
    result: IntegrationDiscoveryResult | null,
    error: string | null,
  ): void {
    const now = this.#now();
    stored.value = {
      ...stored.value,
      status,
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#completedTtlMs).toISOString(),
      result,
      error,
    };
    this.#publish(stored);
  }

  #publish(stored: StoredDiscoveryJob): void {
    for (const listener of [...(this.#listeners.get(stored.ownerId) ?? [])]) {
      try {
        listener(copy(stored.value));
      } catch {
        // One browser listener must not affect discovery or other listeners.
      }
    }
  }

  #cleanup(): void {
    const now = this.#now();
    for (const [id, stored] of this.#jobs) {
      if (stored.value.status === "running" || Date.parse(stored.value.expiresAt) > now) continue;
      this.#jobs.delete(id);
      const key = this.#key(stored.ownerId, stored.value.houseId);
      if (this.#latest.get(key) === id) this.#latest.delete(key);
    }
  }

  #key(ownerId: string, houseId: string): string {
    return `${ownerId}\u0000${houseId}`;
  }
}
