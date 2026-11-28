import type { AdaptiveSettingsScope } from "@climate-twin/contracts";

const selectionChange = "adaptive-finding-selection";

export function subscribeToAdaptiveFinding(restore: () => void) {
  window.addEventListener("popstate", restore);
  window.addEventListener(selectionChange, restore);
  return () => {
    window.removeEventListener("popstate", restore);
    window.removeEventListener(selectionChange, restore);
  };
}

export function adaptiveFindingFromLocation(scope: AdaptiveSettingsScope) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("adaptiveHome") !== scope.houseId || params.get("adaptiveMode") !== scope.dataMode) return null;
  const id = params.get("adaptiveFinding");
  return id && id.length <= 80 ? id : null;
}

export function writeAdaptiveFinding(scope: AdaptiveSettingsScope, findingId: string | null) {
  const url = new URL(window.location.href);
  for (const param of ["adaptiveHome", "adaptiveMode", "adaptiveFinding"]) url.searchParams.delete(param);
  if (findingId) {
    url.searchParams.set("adaptiveHome", scope.houseId);
    url.searchParams.set("adaptiveMode", scope.dataMode);
    url.searchParams.set("adaptiveFinding", findingId);
  }
  if (url.href !== window.location.href) {
    window.history.pushState({ ...window.history.state, adaptiveFinding: findingId }, "", url);
    window.dispatchEvent(new Event(selectionChange));
  }
}
