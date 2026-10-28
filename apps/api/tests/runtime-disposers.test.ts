import { describe, expect, it } from "vitest";
import { RuntimeDisposers } from "../src/app/runtime-disposers.js";

describe("RuntimeDisposers", () => {
  it("stops everything once, in registration order, and waits for asynchronous stops", async () => {
    const disposers = new RuntimeDisposers();
    const calls: string[] = [];
    let finishSlowStop!: () => void;
    disposers.stopOnShutdown(() => { calls.push("sync"); });
    disposers.stopOnShutdown(() => new Promise<void>((resolve) => { calls.push("async"); finishSlowStop = resolve; }));
    disposers.stopOnShutdown(() => { calls.push("last"); });

    let settled = false;
    const stopping = disposers.stopAll().then(() => { settled = true; });
    expect(calls).toEqual(["sync", "async", "last"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    finishSlowStop();
    await stopping;
    await disposers.stopAll();
    expect(calls).toEqual(["sync", "async", "last"]);
  });

  it("releases wakes once", () => {
    const disposers = new RuntimeDisposers();
    let released = 0;
    disposers.releaseOnClose(() => { released += 1; });
    disposers.releaseAll();
    disposers.releaseAll();
    expect(released).toBe(1);
  });
});
