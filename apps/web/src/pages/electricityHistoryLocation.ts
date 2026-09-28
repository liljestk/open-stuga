export type ElectricityChartMode = "single" | "multiple" | "combined";
export interface ElectricityHistoryLocation {
  mode: ElectricityChartMode;
  source: string;
  sources: string[] | null;
}

export function electricityHistoryLocation(): ElectricityHistoryLocation {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const requested = params.get("view");
  return {
    mode: requested === "single" || requested === "multiple" ? requested : "combined",
    source: params.get("source") ?? "",
    sources: params.has("sources") ? params.getAll("sources").filter(Boolean) : null,
  };
}

export function writeElectricityHistoryLocation(state: ElectricityHistoryLocation): void {
  const url = new URL(window.location.href);
  if (state.mode === "combined") url.searchParams.delete("view");
  else url.searchParams.set("view", state.mode);
  if (state.source) url.searchParams.set("source", state.source);
  else url.searchParams.delete("source");
  url.searchParams.delete("sources");
  if (state.sources !== null) {
    if (!state.sources.length) url.searchParams.set("sources", "");
    else state.sources.forEach((source) => url.searchParams.append("sources", source));
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.pushState(window.history.state, "", next);
  }
}
