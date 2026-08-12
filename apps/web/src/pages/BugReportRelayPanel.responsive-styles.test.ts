import { describe, expect, it } from "vitest";

import bugReportRelayStyles from "./BugReportRelayPanel.css?raw";

describe("BugReportRelayPanel responsive styles", () => {
  it("moves status below the heading copy before it can collapse the copy column", () => {
    expect(bugReportRelayStyles).toMatch(
      /@media \(max-width: 420px\)[\s\S]*?\.bug-report-relay-heading\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/,
    );
    expect(bugReportRelayStyles).toMatch(
      /@media \(max-width: 420px\)[\s\S]*?\.bug-report-relay-state\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2[^}]*justify-self:\s*start/,
    );
  });
});
