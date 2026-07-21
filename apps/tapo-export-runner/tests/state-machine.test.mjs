import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticationPlan,
  classifyUiSignals,
  FlowEngine,
  parseFlowConfig,
} from "../dist/flow.js";
import { calendarDate, dateNavigationVariables, LeaseWatchdog } from "../dist/worker.js";

test("aborts locally at the server lease deadline", async () => {
  const controller = new AbortController();
  const watchdog = new LeaseWatchdog(controller);
  watchdog.arm(125, 100);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason), /safety margin/u);
  watchdog.clear();
});

test("renders export calendar dates in the job house timezone", () => {
  assert.equal(calendarDate("2026-01-14T22:30:00.000Z", "Europe/Helsinki"), "2026-01-15");
  assert.equal(calendarDate("2026-01-15T02:00:00.000Z", "America/New_York"), "2026-01-14");
});

test("derives bounded picker month counts from API server time in the job timezone", () => {
  assert.deepEqual(dateNavigationVariables({
    serverNow: "2026-07-19T20:05:00.000Z",
    from: "2025-06-10T00:00:00.000Z",
    to: "2026-06-10T00:00:00.000Z",
    timeZone: "Europe/Helsinki",
  }), {
    FROM_MONTHS_BEFORE_CURRENT: "13",
    TO_MONTHS_BEFORE_CURRENT: "1",
    MONTHS_FROM_FROM_TO: "12",
  });
  // At this instant UTC is March, but the picker calendar is still February
  // in Los Angeles. The count must follow the job timezone, not the host.
  assert.deepEqual(dateNavigationVariables({
    serverNow: "2026-03-01T00:30:00.000Z",
    from: "2026-01-15T12:00:00.000Z",
    to: "2026-02-15T12:00:00.000Z",
    timeZone: "America/Los_Angeles",
  }), {
    FROM_MONTHS_BEFORE_CURRENT: "1",
    TO_MONTHS_BEFORE_CURRENT: "0",
    MONTHS_FROM_FROM_TO: "1",
  });
  assert.throws(() => dateNavigationVariables({
    serverNow: "2026-07-19T20:05:00.000Z",
    from: "2024-06-01T00:00:00.000Z",
    to: "2026-06-01T00:00:00.000Z",
    timeZone: "Europe/Helsinki",
  }), /safe 0-24 month picker range/u);
});

test("repeatTap resolves a fresh unique picker control for a bounded server count", async () => {
  const selected = [];
  const clicked = [];
  const appium = {
    waitForUniqueElement: async (selector) => {
      selected.push(selector);
      return `month-${selected.length}`;
    },
    click: async (element) => { clicked.push(element); },
  };
  const engine = new FlowEngine(appium, {}, 1_000);
  await engine.execute([{
    action: "repeatTap",
    selector: { using: "id", value: "previous-month" },
    countVariable: "FROM_MONTHS_BEFORE_CURRENT",
    settleMs: 50,
  }], { FROM_MONTHS_BEFORE_CURRENT: "2" }, new AbortController().signal);
  assert.deepEqual(clicked, ["month-1", "month-2"]);
  assert.equal(selected.length, 2);
  await assert.rejects(
    engine.execute([{
      action: "repeatTap",
      selector: { using: "id", value: "previous-month" },
      countVariable: "FROM_MONTHS_BEFORE_CURRENT",
    }], { FROM_MONTHS_BEFORE_CURRENT: "25" }, new AbortController().signal),
    /hard 24-tap limit/u,
  );
});

test("2FA takes precedence over every other detected signal", () => {
  const state = classifyUiSignals({ authenticated: true, login: true, twoFactor: true });
  assert.equal(state, "two_factor");
  assert.equal(authenticationPlan(state, true), "needs_two_factor");
});

test("authentication plans never claim an unknown UI is safe", () => {
  assert.equal(authenticationPlan("authenticated", false), "proceed");
  assert.equal(authenticationPlan("login", true), "auto_login");
  assert.equal(authenticationPlan("login", false), "needs_login");
  assert.equal(authenticationPlan("unknown", true), "needs_ui_review");
});

test("validates the configurable flow before driving a device", () => {
  const value = {
    version: 1,
    appPackage: "com.tplink.iot",
    intervalLabels: {
      1: "1 min", 15: "15 min", 30: "30 min", 60: "1 h", 360: "6 h", 720: "12 h", 1440: "1 day",
    },
    deviceProofs: { "device-1": "serial-1" },
    signals: {
      authenticated: { using: "id", value: "home" },
      twoFactor: { using: "id", value: "otp" },
    },
    flows: {
      export: [
        {
          action: "tap",
          selector: { using: "accessibility id", value: "{{DEVICE_NAME}}" },
          failureCode: "device_not_found",
          requireUnique: true,
        },
        {
          action: "waitFor",
          selector: { using: "xpath", value: "//*[@text='{{DEVICE_NAME}}']" },
          failureCode: "device_not_found",
        },
        {
          action: "waitFor",
          selector: { using: "xpath", value: "//*[@text='{{DEVICE_PROOF}}']" },
          failureCode: "device_not_found",
        },
        { action: "type", selector: { using: "id", value: "from" }, value: "{{FROM_DATE}}" },
        { action: "waitFor", selector: { using: "xpath", value: "//*[@text='{{FROM_DATE}}']" } },
        { action: "type", selector: { using: "id", value: "to" }, value: "{{TO_DATE}}" },
        { action: "waitFor", selector: { using: "xpath", value: "//*[@text='{{TO_DATE}}']" } },
        { action: "tap", selector: { using: "xpath", value: "//*[@text='{{INTERVAL_LABEL}}']" } },
        { action: "waitFor", selector: { using: "xpath", value: "//*[@text='{{INTERVAL_LABEL}}']" } },
        {
          action: "type",
          selector: { using: "id", value: "recipient" },
          value: "{{EXPORT_EMAIL}}",
        },
        { action: "waitForGone", selector: { using: "id", value: "confirmed" } },
        { action: "tap", selector: { using: "id", value: "submit" } },
        { action: "waitFor", selector: { using: "id", value: "confirmed" } },
      ],
    },
  };
  const flow = parseFlowConfig(value);
  assert.equal(flow.version, 1);
  assert.equal(flow.flows.export.length, 13);
  assert.equal(flow.flows.export[0].failureCode, "device_not_found");

  const malicious = structuredClone(value);
  malicious.flows.login = [{
    action: "type",
    selector: { using: "xpath", value: "//*[@text='{{TAPO_PASSWORD}}']" },
    value: "{{TAPO_PASSWORD}}",
  }];
  assert.throws(() => parseFlowConfig(malicious), /selector\.value cannot contain sensitive variable/u);

  for (const login of [
    [{ action: "type", selector: { using: "id", value: "email" }, value: "{{TAPO_USERNAME}}" }],
    [
      { action: "type", selector: { using: "id", value: "email" }, value: "{{TAPO_USERNAME}}" },
      { action: "type", selector: { using: "id", value: "email-2" }, value: "{{TAPO_USERNAME}}" },
      { action: "type", selector: { using: "id", value: "password" }, value: "{{TAPO_PASSWORD}}" },
    ],
    [
      { action: "type", selector: { using: "id", value: "email" }, value: "{{TAPO_USERNAME}}", optional: true },
      { action: "type", selector: { using: "id", value: "password" }, value: "{{TAPO_PASSWORD}}" },
    ],
    [
      { action: "type", selector: { using: "id", value: "email" }, value: "{{TAPO_USERNAME}}" },
      { action: "type", selector: { using: "id", value: "password" }, value: "{{TAPO_PASSWORD}}", clearFirst: false },
    ],
  ]) {
    const invalid = structuredClone(value);
    invalid.flows.login = login;
    assert.throws(() => parseFlowConfig(invalid), /exactly one non-optional clearing type action/u);
  }

  const staleConfirmation = structuredClone(value);
  staleConfirmation.flows.export = staleConfirmation.flows.export.filter(
    (entry) => entry.action !== "waitForGone",
  );
  assert.throws(
    () => parseFlowConfig(staleConfirmation),
    /confirmation selector is absent immediately before submit/u,
  );

  const pickerFlow = structuredClone(value);
  let fromIndex = pickerFlow.flows.export.findIndex((entry) => entry.value === "{{FROM_DATE}}");
  pickerFlow.flows.export[fromIndex] = {
    action: "tap",
    selector: { using: "xpath", value: "{{FROM_YEAR}}-{{FROM_MONTH}}-{{FROM_DAY}}" },
  };
  pickerFlow.flows.export.splice(fromIndex, 0, {
    action: "repeatTap",
    selector: { using: "id", value: "previous-month" },
    countVariable: "FROM_MONTHS_BEFORE_CURRENT",
  });
  let toIndex = pickerFlow.flows.export.findIndex((entry) => entry.value === "{{TO_DATE}}");
  pickerFlow.flows.export[toIndex] = {
    action: "tap",
    selector: { using: "xpath", value: "{{TO_YEAR}}-{{TO_MONTH}}-{{TO_DAY}}" },
  };
  pickerFlow.flows.export.splice(toIndex, 0, {
    action: "repeatTap",
    selector: { using: "id", value: "next-month" },
    countVariable: "MONTHS_FROM_FROM_TO",
  });
  assert.doesNotThrow(() => parseFlowConfig(pickerFlow));

  const staticPicker = structuredClone(pickerFlow);
  staticPicker.flows.export = staticPicker.flows.export.filter(
    (entry) => entry.countVariable !== "FROM_MONTHS_BEFORE_CURRENT",
  );
  assert.throws(
    () => parseFlowConfig(staticPicker),
    /tap-based FROM selection must navigate/u,
  );

  const arbitraryRepeat = structuredClone(value);
  arbitraryRepeat.flows.export.unshift({
    action: "repeatTap",
    selector: { using: "id", value: "month" },
    countVariable: "JOB_ID",
  });
  assert.throws(
    () => parseFlowConfig(arbitraryRepeat),
    /three server-derived month variables/u,
  );

  const templatedRepeat = structuredClone(value);
  templatedRepeat.flows.export.unshift({
    action: "repeatTap",
    selector: { using: "id", value: "{{DEVICE_NAME}}" },
    countVariable: "FROM_MONTHS_BEFORE_CURRENT",
  });
  assert.throws(
    () => parseFlowConfig(templatedRepeat),
    /repeatTap selector must be static/u,
  );
});

test("rejects an empty export flow or unsupported selectors", () => {
  assert.throws(
    () => parseFlowConfig({
      version: 1,
      appPackage: "com.tplink.iot",
      intervalLabels: { 1: "1 min", 15: "15 min", 30: "30 min", 60: "1 h", 360: "6 h", 720: "12 h", 1440: "1 day" },
      signals: { authenticated: { using: "css selector", value: ".home" } },
      flows: { export: [] },
    }),
    /supported selector/u,
  );
  assert.throws(
    () => parseFlowConfig({
      version: 1,
      appPackage: "com.tplink.iot",
      intervalLabels: { 1: "1 min", 15: "15 min", 30: "30 min", 60: "1 h", 360: "6 h", 720: "12 h", 1440: "1 day" },
      signals: { authenticated: { using: "id", value: "home" } },
      flows: { export: [] },
    }),
    /at least one action/u,
  );
});
