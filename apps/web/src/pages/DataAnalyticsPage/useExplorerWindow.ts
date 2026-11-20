import { useState } from "react";
import type { ScopedAnalyticsWindow } from "./explorerState";

export function useExplorerWindow(input: { houseId: string; dataMode: string; initial: ScopedAnalyticsWindow | undefined }) {
  const scope = JSON.stringify([input.houseId, input.dataMode]);
  const [storedWindow, setAbsoluteRange] = useState(input.initial);
  const [storedBrush, setStoredBrush] = useState({ scope, value: false });
  const [storedSelection, setStoredSelection] = useState<{ scope: string; value: { start: string; end: string } | null }>({ scope, value: null });
  return {
    absoluteRange: matchingWindow(storedWindow, input),
    setAbsoluteRange,
    brush: storedBrush.scope === scope && storedBrush.value,
    setBrush: (value: boolean) => setStoredBrush({ scope, value }),
    brushSelection: storedSelection.scope === scope ? storedSelection.value : null,
    setBrushSelection: (value: { start: string; end: string } | null) => setStoredSelection({ scope, value }),
  };
}
function matchingWindow(window: ScopedAnalyticsWindow | undefined, scope: { houseId: string; dataMode: string }) {
  return window?.houseId === scope.houseId && window.dataMode === scope.dataMode ? window : undefined;
}
