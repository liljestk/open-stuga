import { type StugubySummary, STUGBY_PROTOCOL_VERSION, validateSignedEvent, STUGBY_MAX_EVENT_PAGE_BYTES } from "@climate-twin/stuguby-protocol";
import { StugubyError } from "../support/service-types.js";
import { recordValue } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";
import { abortableDelay } from "../../../abortable-delay.js";

const PULL_RETRY_MIN_MS = 5_000;

const PULL_RETRY_MAX_MS = 300_000;

function pullRetryDelay(syncIntervalMs: number, failures: number): number {
  const base = Math.max(PULL_RETRY_MIN_MS, syncIntervalMs);
  return Math.min(PULL_RETRY_MAX_MS, base * 2 ** Math.min(Math.max(0, failures - 1), 8));
}

const STREAM_RETRY_BASE_MS = 5_000;

const STREAM_RETRY_MAX_MS = 300_000;

const STREAM_AUTH_RETRY_MIN_MS = 300_000;

const STREAM_STABLE_MS = 60_000;

const SLOW_STREAM_STATUS = new Set([401, 403, 404, 426]);

function streamRetryDelay(failures: number, status?: number): number {
  const exponential = Math.min(
    STREAM_RETRY_MAX_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, failures - 1), 8),
  );
  return status !== undefined && SLOW_STREAM_STATUS.has(status)
    ? Math.max(STREAM_AUTH_RETRY_MIN_MS, exponential)
    : exponential;
}

declare module "../core.js" {
  interface StugubyServiceInternals {
    start(): void;
    stop(): Promise<void>;
    trackSync<T>(operation: Promise<T>): Promise<T>;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
    syncFederation(stugubyId: string, throwOnError: boolean, bypassCooldown?: boolean): Promise<void>;
    ensureNotificationStreams(): void;
    notificationLoop(stugubyId: string, controller: AbortController): Promise<void>;
    syncOne(stugubyId: string, throwOnError: boolean): Promise<void>;
  }

  interface StugubyServiceCore {
    start(): void;
    stop(): Promise<void>;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
  }
}

registerStugubyServiceMethods({
  start(this: StugubyServiceInternals): void {
      const state = this[stugubyServiceState];
      if (state.lifecycleController.signal.aborted) state.lifecycleController = new AbortController();
      state.started = true;
      if (!state.removeMeasurementListener) {
        state.removeMeasurementListener = state.bus.subscribeMeasurements((sample) => this.publishLiveTelemetry(sample));
      }
      if (!state.timer) {
        state.timer = setInterval(() => { void this.syncAll().catch(() => undefined); }, state.syncIntervalMs);
        state.timer.unref();
      }
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      this.ensureNotificationStreams();
      void this.syncAll().catch(() => undefined);
    },
  async stop(this: StugubyServiceInternals): Promise<void> {
      const state = this[stugubyServiceState];
      state.started = false;
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      state.removeMeasurementListener?.();
      state.removeMeasurementListener = null;
      state.lifecycleController.abort(new Error("Stuguby service is stopping"));
      for (const controller of state.streamControllers.values()) controller.abort();
      state.streamControllers.clear();
      for (const close of state.incomingNotificationStreams.values()) close();
      state.incomingNotificationStreams.clear();
      await Promise.allSettled([...state.streamTasks.values()]);
      await Promise.allSettled([...state.activeSyncs]);
    },
  trackSync<T>(this: StugubyServiceInternals, operation: Promise<T>): Promise<T> {
      const state = this[stugubyServiceState];
      state.activeSyncs.add(operation);
      void operation.then(
        () => { state.activeSyncs.delete(operation); },
        () => { state.activeSyncs.delete(operation); },
      );
      return operation;
    },
  async syncNow(this: StugubyServiceInternals, stugubyId: string): Promise<StugubySummary> {
      this.requireStuguby(stugubyId);
      this.backfillRecommendedHomeOverviews(stugubyId);
      await this.syncFederation(stugubyId, true, true);
      return this.requireStuguby(stugubyId);
    },
  async syncFederation(this: StugubyServiceInternals, stugubyId: string, throwOnError: boolean, bypassCooldown = false): Promise<void> {
      const state = this[stugubyServiceState];
      const existing = state.federationSyncs.get(stugubyId);
      if (existing) {
        try {
          await existing;
        } catch (error) {
          if (throwOnError) throw error;
        }
        return;
      }
      const retry = state.pullRetries.get(stugubyId);
      if (!bypassCooldown && retry && retry.retryAt > Date.now()) return;
      const operation = this.trackSync((async () => {
        try {
          await this.syncOne(stugubyId, true);
          state.pullRetries.delete(stugubyId);
        } catch (error) {
          const failures = (state.pullRetries.get(stugubyId)?.failures ?? 0) + 1;
          state.pullRetries.set(stugubyId, {
            failures,
            retryAt: Date.now() + pullRetryDelay(state.syncIntervalMs, failures),
          });
          throw error;
        }
      })());
      state.federationSyncs.set(stugubyId, operation);
      try {
        await operation;
      } catch (error) {
        if (throwOnError) throw error;
      } finally {
        if (state.federationSyncs.get(stugubyId) === operation) {
          state.federationSyncs.delete(stugubyId);
        }
      }
    },
  async syncAll(this: StugubyServiceInternals): Promise<void> {
      const state = this[stugubyServiceState];
      if (state.syncing) return state.syncing;
      const operation = (async () => {
        this.deleteUnreferencedBlobs(this.store.staleUnreferencedBlobs(new Date(Date.now() - 86_400_000).toISOString()));
        this.ensureNotificationStreams();
        for (const stuguby of this.store.listStugubys()) {
          this.backfillRecommendedHomeOverviews(stuguby.id);
          this.expireLocalGrants(stuguby.id);
          if (this.store.isCoordinator(stuguby.id) || !["active", "suspended"].includes(stuguby.localMemberState)) continue;
          await this.syncFederation(stuguby.id, false);
        }
      })();
      state.syncing = this.trackSync(operation).finally(() => { state.syncing = null; });
      return state.syncing;
    },
  ensureNotificationStreams(this: StugubyServiceInternals): void {
      const state = this[stugubyServiceState];
      if (!state.started) return;
      for (const [stugubyId, controller] of state.streamControllers) {
        const stuguby = this.store.getStuguby(stugubyId);
        if (!stuguby || !["active", "suspended"].includes(stuguby.localMemberState) || this.store.isCoordinator(stugubyId)) {
          controller.abort();
          state.streamControllers.delete(stugubyId);
        }
      }
      for (const stuguby of this.store.listStugubys()) {
        if (this.store.isCoordinator(stuguby.id) || !["active", "suspended"].includes(stuguby.localMemberState) || state.streamControllers.has(stuguby.id)) continue;
        const controller = new AbortController();
        state.streamControllers.set(stuguby.id, controller);
        const task = this.notificationLoop(stuguby.id, controller);
        state.streamTasks.set(stuguby.id, task);
        void task.then(
          () => { if (state.streamTasks.get(stuguby.id) === task) state.streamTasks.delete(stuguby.id); },
          () => { if (state.streamTasks.get(stuguby.id) === task) state.streamTasks.delete(stuguby.id); },
        );
      }
    },
  async notificationLoop(this: StugubyServiceInternals, stugubyId: string, controller: AbortController): Promise<void> {
      const state = this[stugubyServiceState];
      let failures = 0;
      try {
        while (!controller.signal.aborted && state.started) {
          let connectedAt: number | null = null;
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
          let failure: unknown;
          try {
            const stuguby = this.requireStuguby(stugubyId);
            const cursor = this.store.pullCursor(stugubyId);
            const path = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events/stream?cursor=${cursor}`;
            const response = await this.signedFetch(stuguby, path, {
              method: "GET",
              signal: controller.signal,
              stream: true,
            });
            if (!response.ok || !response.body) throw await this.remoteError(response, "Stuguby notification stream failed");
            connectedAt = Date.now();
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffered = "";
            while (!controller.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
              if (Buffer.byteLength(buffered) > 64 * 1024) {
                throw new StugubyError(502, "INVALID_NOTIFICATION_STREAM", "Coordinator returned an oversized Stuguby notification frame");
              }
              let boundary = buffered.indexOf("\n\n");
              while (boundary >= 0) {
                const frame = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 2);
                const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
                const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
                if (eventName === "available" && data) {
                  const next = JSON.parse(data) as { cursor?: unknown };
                  if (typeof next.cursor === "number" && next.cursor > this.store.pullCursor(stugubyId)) {
                    await this.syncFederation(stugubyId, false);
                  }
                }
                boundary = buffered.indexOf("\n\n");
              }
            }
            if (!controller.signal.aborted) throw new Error("Stuguby notification stream ended");
          } catch (error) {
            failure = error;
          } finally {
            await reader?.cancel().catch(() => undefined);
          }
          if (controller.signal.aborted || !state.started) break;
          if (connectedAt !== null && Date.now() - connectedAt >= STREAM_STABLE_MS) failures = 0;
          failures += 1;
          const status = failure instanceof StugubyError ? failure.status : undefined;
          await abortableDelay(streamRetryDelay(failures, status), controller.signal);
        }
      } finally {
        if (state.streamControllers.get(stugubyId) === controller) state.streamControllers.delete(stugubyId);
      }
    },
  async syncOne(this: StugubyServiceInternals, stugubyId: string, throwOnError: boolean): Promise<void> {
      const stuguby = this.requireStuguby(stugubyId);
      this.expireLocalGrants(stugubyId);
      this.store.enforceRetention(stugubyId);
      this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugubyId));
      if (this.store.isCoordinator(stugubyId)) {
        this.store.recordSync(stugubyId, this.store.pullCursor(stugubyId), null);
        this.materializeAllRemoteHomes(stugubyId);
        this.refreshPropertyLink(stugubyId);
        return;
      }
      try {
        if (stuguby.localMemberState === "active") {
          await this.flushHomeCommands(stuguby);
          await this.flushPropertyCommands(stuguby);
          await this.flushOutbox(stuguby);
        }
        let cursor = this.store.pullCursor(stugubyId);
        let hasMore = true;
        while (hasMore) {
          const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events?cursor=${cursor}&limit=100`, { method: "GET" });
          if (!response.ok) throw await this.remoteError(response, "Stuguby event pull failed");
          const rawPage = recordValue(
            await this.readJsonResponse(response, STUGBY_MAX_EVENT_PAGE_BYTES + 64 * 1024, "Event page"),
            "Event page",
          );
          if (rawPage.protocolVersion !== STUGBY_PROTOCOL_VERSION || !Array.isArray(rawPage.events)
            || rawPage.events.length > 100 || !Number.isSafeInteger(rawPage.cursor) || Number(rawPage.cursor) < cursor
            || typeof rawPage.hasMore !== "boolean"
            || (rawPage.events.length > 0 && Number(rawPage.cursor) <= cursor)
            || (rawPage.events.length === 0 && Number(rawPage.cursor) !== cursor)
            || (rawPage.hasMore && rawPage.events.length === 0)) {
            throw new StugubyError(502, "INVALID_EVENT_PAGE", "Coordinator returned an invalid or non-progressing Stuguby event page");
          }
          for (const candidate of rawPage.events) await this.applyPulledEvent(stuguby, validateSignedEvent(candidate));
          cursor = Number(rawPage.cursor);
          hasMore = rawPage.hasMore;
          this.store.recordSync(stugubyId, cursor, null);
        }
        this.store.markRemoteCurrent(stugubyId);
        this.materializeAllRemoteHomes(stugubyId);
        this.refreshPropertyLink(stugubyId);
        this.store.enforceRetention(stugubyId);
        this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugubyId));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1_000) : "Stuguby sync failed";
        this.store.recordSync(stugubyId, this.store.pullCursor(stugubyId), message);
        this.store.markRemoteStale(stugubyId);
        this.materializeAllRemoteHomes(stugubyId);
        this.refreshPropertyLink(stugubyId, "offline");
        if (throwOnError) throw error;
      }
    },
});
