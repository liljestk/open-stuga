import type {
  AlertEvent,
  AlertRule,
} from "@climate-twin/contracts";

import { describe, expect, it } from "vitest";

import {
  deriveHomeInsights,
  deriveHomePulse,
} from "../src/analytics/home-monitoring/insights.js";

import { baseInput, sample, sensor } from "./home-monitoring-test-support.js";

describe("deriveHomePulse", () => {
  it("uses the alert operator for advice and always keeps critical alerts above warnings", () => {
    const nursery = sensor("nursery", "Nursery");
    const office = sensor("office", "Office");
    const lowHumidityRule: AlertRule = {
      id: "low-humidity",
      name: "Low humidity",
      sensorId: nursery.id,
      metric: "humidity",
      operator: "lt",
      threshold: 30,
      durationSeconds: 600,
      severity: "critical",
      enabled: true,
      webhookEnabled: false,
      telegramEnabled: false,
    };
    const criticalAlert: AlertEvent = {
      id: "low-humidity-alert",
      ruleId: lowHumidityRule.id,
      sensorId: nursery.id,
      metric: "humidity",
      value: 25,
      threshold: 30,
      severity: "critical",
      startedAt: "2026-07-14T11:30:00.000Z",
      acknowledgedAt: "2026-07-14T11:35:00.000Z",
      resolvedAt: null,
    };
    const insights = deriveHomeInsights(baseInput({
      sensors: [nursery, office],
      latestMeasurements: {
        [nursery.id]: { humidity: sample(nursery, "humidity", 25, 3) },
        [office.id]: { co2: sample(office, "co2", 2_500, 3) },
      },
      alerts: [criticalAlert],
      alertRules: [lowHumidityRule],
      maxInsights: 2,
    }));

    expect(insights.map((item) => item.severity)).toEqual(["critical", "warning"]);
    expect(insights[0]?.id).toBe("active-alert:low-humidity-alert");
    expect(insights[0]?.action).toContain("follow the configured alert rule");
    expect(insights[0]?.action).not.toMatch(/extractor|dehumidifier/i);
  });

  it("rejects an invalid reference time instead of consulting the wall clock", () => {
    expect(() => deriveHomePulse(baseInput({ referenceTime: "not-a-time" }))).toThrow(RangeError);
  });
});
