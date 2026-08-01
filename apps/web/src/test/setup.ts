import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { deactivateAccountStorage } from "../browserStorage";

afterEach(() => cleanup());

beforeEach(() => {
  // Every browser test starts at a neutral location. Query-backed page state
  // must never leak between otherwise independent direct-render tests.
  window.history.replaceState(null, "", "/");
  deactivateAccountStorage();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API unavailable in unit tests")));
});
