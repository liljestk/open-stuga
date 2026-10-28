export class McpOperationTracker {
  readonly #active = new Set<Promise<unknown>>();
  #accepting = true;

  get accepting(): boolean {
    return this.#accepting;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.#accepting) return Promise.reject(new Error("MCP server is shutting down"));
    const pending = Promise.resolve().then(operation);
    this.#active.add(pending);
    void pending.then(
      () => this.#active.delete(pending),
      () => this.#active.delete(pending),
    );
    return pending;
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const drain = async (): Promise<void> => {
      while (this.#active.size > 0) {
        await Promise.allSettled([...this.#active]);
      }
    };
    if (timeoutMs === undefined) {
      await drain();
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drain(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `MCP shutdown timed out with ${this.#active.size} active operation(s)`,
          )), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export type McpToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

export function runMcpToolRequest(
  tracker: McpOperationTracker,
  handlers: Readonly<Record<string, McpToolHandler>>,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) return Promise.reject(new Error(`Unknown tool: ${name}`));
  return tracker.run(() => {
    signal?.throwIfAborted();
    return handler(args, signal);
  });
}
