import { ADAPTIVE_DEFAULTS } from "@climate-twin/contracts";
import type { TelemetryBus } from "../../events.js";
import type { AnalyticsWorkLimiter } from "../work-limiter.js";
import type { AdaptiveMonitoringService } from "./service.js";

export class AdaptiveMonitoringWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private removeWake: (() => void) | null = null;
  private lastRetention = 0;
  constructor(readonly options: {
    service: AdaptiveMonitoringService; limiter: AnalyticsWorkLimiter; bus: TelemetryBus;
    admit(): boolean | Promise<boolean>; onError(error: unknown): void;
  }) {}
  start(): void {
    if (this.started) return;
    this.started = true;
    this.removeWake = this.options.bus.subscribe(e => {
      if (e.type !== "mutation") return;
      this.controller?.abort(new DOMException("Learning evidence changed", "AbortError"));
      this.options.service.invalidate();
    });
    this.schedule(120_000);
  }
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.removeWake?.();
    this.removeWake = null;
    this.controller?.abort(new DOMException("Learning stopped", "AbortError"));
    await this.running;
  }
  changed(): void {
    this.controller?.abort(new DOMException("Learning settings changed", "AbortError"));
  }
  handleDataModeActivated(): void {
    this.changed();
    this.options.service.store.purgeOtherMode(this.options.service.activeMode());
  }
  private schedule(delay: number): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.run().catch(this.options.onError).finally(() => { this.running = null; this.schedule(60_000); });
    }, delay);
    this.timer.unref();
  }
  async run(): Promise<void> {
    const { service, limiter } = this.options;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(new DOMException("Learning time budget reached", "TimeoutError")), ADAPTIVE_DEFAULTS.deadlineMs);
    try {
      await limiter.runLowPriority("adaptive-monitoring", async () => {
        const streams = service.streamsToProcess();
        if (!streams.length) return;
        if (!await this.options.admit()) {
          for (const s of streams) {
            s.stream.state = "paused"; s.stream.reason = "resource-pressure";
            service.store.saveStream(s, service.activeMode());
          }
          return;
        }
        const db = service.options.database.db;
        const cursor = (db.prepare("SELECT value FROM metadata WHERE key='adaptive_scheduler_cursor'").get() as { value: string } | undefined)?.value ?? "";
        const rotated = [...streams.filter(s => s.stream.id > cursor), ...streams.filter(s => s.stream.id <= cursor)];
        const budget = { remaining: ADAPTIVE_DEFAULTS.maximumInputSamples as number };
        for (const s of rotated.slice(0, ADAPTIVE_DEFAULTS.workerStreams)) {
          controller.signal.throwIfAborted();
          db.prepare("INSERT INTO metadata(key,value) VALUES('adaptive_scheduler_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(s.stream.id);
          await service.process(s, controller.signal, budget);
        }
        if (service.now() - this.lastRetention > 86_400_000) {
          service.store.retain(service.now());
          this.lastRetention = service.now();
        }
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      if (this.controller === controller) this.controller = null;
    }
  }
}
