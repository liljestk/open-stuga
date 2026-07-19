import axe from "axe-core";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { LocalAuthPage } from "./LocalAuthPage";

describe("LocalAuthPage accessibility", () => {
  it.each(["login", "setup"] as const)("has no automated accessibility violations in %s mode", async (mode) => {
    const { container } = render(
      <I18nProvider>
        <LocalAuthPage mode={mode} onAuthenticated={vi.fn()} />
      </I18nProvider>,
    );

    const result = await axe.run(container, {
      rules: {
        // jsdom does not compute the visual styles needed for a reliable contrast result.
        "color-contrast": { enabled: false },
      },
    });

    expect(result.violations).toEqual([]);
  });
});
