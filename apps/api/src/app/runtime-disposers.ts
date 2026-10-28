/**
 * What createApi started or subscribed, registered where it is created, so
 * shutdown and close drain one list instead of hand-maintained copies.
 */
export class RuntimeDisposers {
  readonly #stops: Array<() => void | Promise<void>> = [];
  readonly #releases: Array<() => void> = [];

  /** Background work and owned resources, stopped by beginShutdown in registration order. */
  stopOnShutdown(stop: () => void | Promise<void>): void {
    this.#stops.push(stop);
  }

  /** Internal wakes and listeners, removed by close before the database closes. */
  releaseOnClose(release: () => void): void {
    this.#releases.push(release);
  }

  /** Calls every stop now, in registration order, and resolves once the asynchronous ones finish. */
  stopAll(): Promise<void> {
    return Promise.all(this.#stops.splice(0).map((stop) => stop())).then(() => undefined);
  }

  releaseAll(): void {
    for (const release of this.#releases.splice(0)) release();
  }
}
