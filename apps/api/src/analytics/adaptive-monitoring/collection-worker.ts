import { addAbortListener } from "node:events";
import type { AdaptiveEvidenceScope, DataMode } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { ClimateDataValidationError } from "../../db/support/validation-errors.js";
import { reportBackgroundFailure, type FailureLog } from "../../system-error-log.js";
import { yieldToEventLoop } from "../../timeseries/read-support.js";
import { HOUR_MS } from "../forecast/models.js";
import {
  AnalyticsCapacityError, BACKGROUND_ANALYTICS_STARTUP_GRACE_MS, type AnalyticsWorkLimiter,
} from "../work-limiter.js";
import { ADAPTIVE_CAPTURE_HORIZON_MS } from "./closed-hour.js";
import { AdaptiveCollectionStore } from "./collection-store.js";
import { AdaptiveClimateArtifacts } from "./climate-artifacts.js";
import { AdaptiveClimateLedger } from "./climate-ledger.js";
import { AdaptiveReferenceDetector } from "./reference-detector.js";

const BETWEEN_PASSES_MS = 60_000;
const DEADLINE_MS = 30_000;
const MAX_STREAMS_PER_PASS = 32;
const MAX_HOURS_PER_STREAM = 4;

type PauseReason = "host-pressure" | "deadline" | "analytics-capacity";

interface CollectionProgress {
  streams: number;
  observations: number;
  gaps: number;
  unavailableHours: number;
  scopeChanges: number;
  qualifications: number;
  predictions: number;
  outcomes: number;
  referenceQualifications: number;
}

type CollectionState =
  | { state: "idle" | "running" | "failed" | "stopped" }
  | { state: "paused"; reason: PauseReason };

interface Options {
  database: ClimateDatabase;
  limiter: AnalyticsWorkLimiter;
  admit: () => boolean | Promise<boolean>;
  systemErrorLog?: FailureLog;
}

function emptyProgress(): CollectionProgress {
  return { streams: 0, observations: 0, gaps: 0, unavailableHours: 0, scopeChanges: 0, qualifications: 0,
    predictions: 0, outcomes: 0, referenceQualifications: 0 };
}

function scopeWasRevoked(error: unknown): boolean {
  return error instanceof ClimateDataValidationError
    && ["HOUSE_NOT_FOUND", "ANALYTICS_DATA_MODE_MISMATCH"].includes(error.code);
}

async function admitUntilCancelled(admit: Options["admit"], signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      subscription = addAbortListener(signal, () => reject(signal.reason));
      Promise.resolve(admit()).then(resolve, reject);
    });
  } finally {
    subscription?.[Symbol.dispose]();
  }
}

export class AdaptiveCollectionWorker {
  readonly #store: AdaptiveCollectionStore;
  readonly #climateArtifacts: AdaptiveClimateArtifacts;
  readonly #climateLedger: AdaptiveClimateLedger;
  readonly #references: AdaptiveReferenceDetector;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #active: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #started = false;
  #state: CollectionState = { state: "stopped" };
  #progress = emptyProgress();

  constructor(private readonly options: Options) {
    this.#store = new AdaptiveCollectionStore(options.database);
    this.#climateArtifacts = new AdaptiveClimateArtifacts(options.database);
    this.#climateLedger = new AdaptiveClimateLedger(options.database, this.#climateArtifacts);
    this.#references = new AdaptiveReferenceDetector(options.database);
  }

  status(): CollectionState & CollectionProgress {
    return { ...this.#state, ...this.#progress };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#state = { state: "idle" };
    this.#schedule(BACKGROUND_ANALYTICS_STARTUP_GRACE_MS);
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    await this.#active;
    this.#state = { state: "stopped" };
  }

  runOnce(): Promise<void> {
    if (this.#active) return this.#active;
    const controller = new AbortController();
    this.#controller = controller;
    this.#active = this.#run(controller.signal).finally(() => {
      this.#controller = null;
      this.#active = null;
    });
    return this.#active;
  }

  #schedule(delay: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.runOnce().finally(() => this.#schedule(BETWEEN_PASSES_MS));
    }, delay);
    this.#timer.unref();
  }

  async #run(stopSignal: AbortSignal): Promise<void> {
    this.#progress = emptyProgress();
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    const signal = AbortSignal.any([stopSignal, deadline]);
    try {
      const dataMode = this.#store.dataMode();
      const optedIn = this.#store.hasOptIn(dataMode);
      if (!optedIn && !this.#store.hasExpiredEvidence() && !this.#climateLedger.hasExpired() && !this.#references.hasExpiredEvidence()) {
        this.#state = { state: "idle" };
        return;
      }
      const lease = await this.options.limiter.acquireLowPriority(
        "adaptive-collection", () => admitUntilCancelled(this.options.admit, signal), signal,
      );
      if (!lease) {
        this.#state = { state: "paused", reason: "host-pressure" };
        return;
      }
      try {
        signal.throwIfAborted();
        this.#state = { state: "running" };
        await this.#collect(dataMode, signal);
        signal.throwIfAborted();
        this.options.database.pruneAdaptiveHours();
        this.#climateLedger.pruneExpired();
        this.#references.pruneExpired();
      } finally {
        await lease.release();
      }
      this.#state = { state: "idle" };
    } catch (error) {
      if (stopSignal.aborted) this.#state = { state: "stopped" };
      else if (deadline.aborted) this.#state = { state: "paused", reason: "deadline" };
      else if (error instanceof AnalyticsCapacityError) this.#state = { state: "paused", reason: "analytics-capacity" };
      else {
        this.#state = { state: "failed" };
        reportBackgroundFailure(this.options.systemErrorLog, {
          level: "warning", source: "adaptive-collection", code: "ADAPTIVE_CAPTURE_FAILED",
          message: "Adaptive Home evidence collection will retry",
        });
      }
    }
  }

  async #collect(dataMode: DataMode, signal: AbortSignal): Promise<void> {
    if (this.#store.dataMode() !== dataMode) return;
    for (const scope of this.#store.streams(dataMode, MAX_STREAMS_PER_PASS)) {
      signal.throwIfAborted();
      if (this.#store.dataMode() !== dataMode) return;
      this.#progress.streams += 1;
      try {
        await this.#collectStream(scope, signal);
      } catch (error) {
        if (!scopeWasRevoked(error)) throw error;
        this.#progress.scopeChanges += 1;
      }
      this.#store.checkpointStream(scope);
      await yieldToEventLoop();
    }
  }

  async #collectStream(scope: AdaptiveEvidenceScope, signal: AbortSignal): Promise<void> {
    const epoch = this.options.database.ensureAdaptiveEvidenceEpoch(scope);
    if (!epoch) return;
    const now = Date.now();
    const firstHour = Math.max(
      Math.ceil(Date.parse(epoch.effectiveAt) / HOUR_MS) * HOUR_MS,
      Math.ceil((now - ADAPTIVE_CAPTURE_HORIZON_MS) / HOUR_MS) * HOUR_MS - HOUR_MS,
      this.#store.nextHour(epoch.id) ?? 0,
    );
    const limit = Math.min(firstHour + MAX_HOURS_PER_STREAM * HOUR_MS, Math.floor(now / HOUR_MS) * HOUR_MS);
    for (let hour = firstHour; hour < limit; hour += HOUR_MS) {
      signal.throwIfAborted();
      const outcome = this.#store.capture(scope, epoch, hour);
      if (outcome === "scope-changed") {
        this.#progress.scopeChanges += 1;
        return;
      }
      if (outcome === "observation") this.#progress.observations += 1;
      if (outcome === "gap") this.#progress.gaps += 1;
      if (outcome === "unavailable") this.#progress.unavailableHours += 1;
      await yieldToEventLoop();
    }
    if (this.#progress.qualifications === 0 && await this.#climateArtifacts.evaluate(epoch, signal)) {
      this.#progress.qualifications = 1;
    }
    signal.throwIfAborted();
    const { predictions, outcomes } = this.#climateLedger.advance(epoch);
    this.#progress.predictions += predictions;
    this.#progress.outcomes += outcomes;
    if (await this.#references.advance(scope, { signal, allowQualification: this.#progress.referenceQualifications === 0 })) {
      this.#progress.referenceQualifications = 1;
    }
  }
}
