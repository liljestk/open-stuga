import { useLayoutEffect, useRef, type ReactNode } from "react";

const PROVIDER_GAP_PX = 16;

export function masonryRowSpan(
  height: number,
  rowHeight: number,
  rowGap: number,
  desiredGap = PROVIDER_GAP_PX,
): number | null {
  const rowUnit = rowHeight + rowGap;
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(rowUnit) || rowUnit <= 0) return null;
  return Math.max(1, Math.ceil((height + desiredGap) / rowUnit));
}

export function SetupProviderGrid({ children, label }: { children: ReactNode; label: string }) {
  const gridRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return undefined;
    const observed = new Set<HTMLElement>();

    const layoutItem = (item: HTMLElement): void => {
      const styles = window.getComputedStyle(grid);
      const span = masonryRowSpan(
        item.getBoundingClientRect().height,
        Number.parseFloat(styles.gridAutoRows),
        Number.parseFloat(styles.rowGap),
      );
      item.style.gridRowEnd = span === null ? "" : `span ${span}`;
    };
    const layoutAll = (): void => {
      for (const item of observed) layoutItem(item);
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === grid) layoutAll();
          else if (entry.target instanceof HTMLElement) layoutItem(entry.target);
        }
      });
    const syncItems = (): void => {
      const current = new Set(Array.from(grid.children).filter((item): item is HTMLElement => item instanceof HTMLElement));
      for (const item of observed) {
        if (current.has(item)) continue;
        resizeObserver?.unobserve(item);
        item.style.gridRowEnd = "";
        observed.delete(item);
      }
      for (const item of current) {
        if (!observed.has(item)) {
          observed.add(item);
          resizeObserver?.observe(item);
        }
        layoutItem(item);
      }
    };

    const mutationObserver = new MutationObserver(syncItems);
    mutationObserver.observe(grid, { childList: true });
    resizeObserver?.observe(grid);
    window.addEventListener("resize", layoutAll);
    syncItems();

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", layoutAll);
      for (const item of observed) item.style.gridRowEnd = "";
    };
  }, []);

  return <div ref={gridRef} className="connection-provider-grid" role="group" aria-label={label}>{children}</div>;
}
