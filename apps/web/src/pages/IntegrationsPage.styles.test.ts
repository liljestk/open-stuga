import { describe, expect, it } from "vitest";

import navigationStyles from "../styles/global/11-history-import-layout-choice-label-span.css?raw";
import setupStyles from "../styles/global/12-setup-connection-home-picker.css?raw";

describe("IntegrationsPage layout styles", () => {
  it("fills the desktop setup navigation with its three primary tabs", () => {
    expect(navigationStyles).toMatch(
      /\.setup-workspace-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/,
    );
  });

  it("separates the completed setup message from the progress heading", () => {
    expect(setupStyles).toMatch(
      /\.setup-steps > \.configured-note\s*\{[^}]*margin-top:\s*18px/,
    );
  });
});
