import { describe, expect, it } from "vitest";
import { McpOperationTracker } from "../src/mcp-lifecycle.js";

describe("MCP operation lifecycle", () => {
  it("rejects new work during shutdown and waits for active tool calls", async () => {
    const tracker = new McpOperationTracker();
    let finish: ((value: string) => void) | undefined;
    const active = tracker.run(() => new Promise<string>((resolve) => { finish = resolve; }));

    await Promise.resolve();
    expect(tracker.activeCount).toBe(1);
    tracker.stopAccepting();
    await expect(tracker.run(() => "too late")).rejects.toThrow("MCP server is shutting down");

    let idle = false;
    const waiting = tracker.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish?.("complete");

    await expect(active).resolves.toBe("complete");
    await waiting;
    expect(idle).toBe(true);
    expect(tracker.activeCount).toBe(0);
  });

  it("also drains failed tool calls", async () => {
    const tracker = new McpOperationTracker();
    const failed = tracker.run(async () => { throw new Error("tool failed"); });
    tracker.stopAccepting();

    await expect(failed).rejects.toThrow("tool failed");
    await expect(tracker.waitForIdle()).resolves.toBeUndefined();
    expect(tracker.activeCount).toBe(0);
  });

  it("bounds shutdown when a tool call does not settle", async () => {
    const tracker = new McpOperationTracker();
    void tracker.run(() => new Promise<never>(() => undefined));
    tracker.stopAccepting();

    await expect(tracker.waitForIdle(5)).rejects.toThrow(
      "MCP shutdown timed out with 1 active operation(s)",
    );
  });
});
