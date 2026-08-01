import { describe, expect, it } from "vitest";

import liveViewStyles from "../styles/global/03-twin-panel-is-full-page-sensor-inspector.css?raw";
import mobileStyles from "../styles/global/15-media-max-width-680px.css?raw";
import accessibilityStyles from "../styles/global/16-portfolio-facts-dd.css?raw";

describe("TwinDashboard Live View responsive styles", () => {
  it("keeps optional controls in a bounded desktop disclosure", () => {
    expect(liveViewStyles).toMatch(
      /\.twin-view-options-menu\s*\{[^}]*position:\s*absolute[^}]*width:\s*min\(340px, calc\(100vw - 32px\)\)/,
    );
    expect(liveViewStyles).toMatch(
      /\.twin-option-list button\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) 18px/,
    );
  });

  it("turns the menu into a full-width inline disclosure at phone widths", () => {
    expect(mobileStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.toolbar-navigation\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(mobileStyles).toMatch(
      /\.toolbar-view-controls\s*\{[^}]*grid-column:\s*1 \/ -1/,
    );
    expect(mobileStyles).toMatch(
      /\.twin-view-options, \.twin-close-live-view\s*\{[^}]*width:\s*100%[^}]*grid-column:\s*1 \/ -1/,
    );
    expect(mobileStyles).toMatch(
      /\.twin-view-options-menu\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*min-width:\s*0/,
    );
  });

  it("keeps every Live View navigation target touch-sized", () => {
    expect(accessibilityStyles).toMatch(
      /\.main-content \.twin-toolbar :is\(select, \.toolbar-navigation button, \.toolbar-edit-actions button, \.twin-view-options summary\)\s*\{[^}]*min-height:\s*44px/,
    );
  });
});
