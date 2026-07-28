import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationDiscoveryJobs } from "../src/integration-discovery-jobs.js";

const emptyResult = { homeAssistant: [], tpLink: [], warnings: [] };

describe("IntegrationDiscoveryJobs", () => {
  const services: IntegrationDiscoveryJobs[] = [];

  afterEach(() => {
    services.splice(0).forEach((service) => service.stop());
  });

  function service(): IntegrationDiscoveryJobs {
    let nextId = 0;
    const value = new IntegrationDiscoveryJobs({
      id: () => `job-${++nextId}`,
    });
    services.push(value);
    return value;
  }

  it("returns immediately and publishes the result when server discovery finishes", async () => {
    const jobs = service();
    let finish!: (value: typeof emptyResult) => void;
    const run = vi.fn(() => new Promise<typeof emptyResult>((resolve) => { finish = resolve; }));
    const listener = vi.fn();
    jobs.subscribe("owner-a", listener);

    const started = jobs.start("owner-a", "house-main", run);

    expect(started).toMatchObject({ status: "running", result: null, error: null });
    expect(run).toHaveBeenCalledOnce();
    finish(emptyResult);
    await vi.waitFor(() => expect(jobs.get("owner-a", started.id)?.status).toBe("completed"));

    expect(jobs.get("owner-a", started.id)?.result).toEqual(emptyResult);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      id: started.id,
      status: "completed",
    }));
  });

  it("keeps jobs owner-scoped and deduplicates concurrent searches for the same Home", async () => {
    const jobs = service();
    const never = vi.fn(() => new Promise<typeof emptyResult>(() => undefined));
    const first = jobs.start("owner-a", "house-main", never);
    const otherOwner = jobs.start("owner-b", "house-main", never);
    const duplicate = jobs.start("owner-a", "house-main", never);

    expect(jobs.get("owner-b", first.id)).toBeNull();
    expect(jobs.get("owner-a", otherOwner.id)).toBeNull();
    expect(duplicate.id).toBe(first.id);
    expect(jobs.get("owner-a", first.id)?.status).toBe("running");
    expect(jobs.latest("owner-a", "house-main")?.id).toBe(first.id);
    expect(never).toHaveBeenCalledTimes(2);
  });

  it("does not expose internal exception details to the browser", async () => {
    const jobs = service();
    const started = jobs.start("owner-a", "house-main", async () => {
      throw new Error("login failed for secret-password");
    });

    await vi.waitFor(() => expect(jobs.get("owner-a", started.id)?.status).toBe("failed"));
    expect(JSON.stringify(jobs.get("owner-a", started.id))).not.toContain("secret-password");
  });
});
