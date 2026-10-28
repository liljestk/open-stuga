import { describe, expect, it } from "vitest";
import { ResponseShapeError } from "@climate-twin/contracts";
import { ApiRequestError, UserFacingError } from "./api";
import { errorText } from "./errorText";
import { en, type TranslationKey } from "./locales/catalogs/en";

const t = (key: TranslationKey) => en[key];

describe("errorText", () => {
  it("never shows the server's or data layer's English message", () => {
    expect(errorText(new ApiRequestError(400, "INVALID_FIELD", "name must be a non-empty string"), t, "Could not save")).toBe("Could not save");
    expect(errorText(new Error("The local API is unavailable. The rule was not saved."), t, "Could not save")).toBe("Could not save");
    expect(errorText(new ResponseShapeError("sensors", "expected an array"), t, "Could not load")).toBe("Could not load");
    expect(errorText(new TypeError("Failed to fetch"), t, "Could not load")).toBe("Could not load");
  });

  it("explains statuses every panel shares", () => {
    expect(errorText(new ApiRequestError(401, "UNAUTHORIZED", "Sign in"), t, "fallback")).toBe(en["requestErrors.signInRequired"]);
    expect(errorText(new ApiRequestError(403, "FORBIDDEN", "No"), t, "fallback")).toBe(en["requestErrors.forbidden"]);
    expect(errorText(new ApiRequestError(429, "RATE_LIMITED", "Slow down"), t, "fallback")).toBe(en["requestErrors.rateLimited"]);
    expect(errorText(new ApiRequestError(503, "BUSY", "Busy"), t, "fallback")).toBe(en["requestErrors.unavailable"]);
  });

  it("keeps a message the UI already translated", () => {
    expect(errorText(new UserFacingError("Koordinaatit annetaan yhdessä."), t, "fallback")).toBe("Koordinaatit annetaan yhdessä.");
  });
});
