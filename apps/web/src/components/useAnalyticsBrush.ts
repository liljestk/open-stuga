import { useState, type PointerEvent } from "react";

export function useAnalyticsBrush(input: {
  from: number; to: number; endLimit: number; width: number; left: number; right: number;
  onSelect?: ((range: { start: string; end: string }) => void) | undefined;
}) {
  const [draft, setDraft] = useState<{ start: number; end: number; pointerX: number } | null>(null);
  const time = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / Math.max(1, bounds.width) * input.width;
    const ratio = Math.max(0, Math.min(1, (position - input.left) / (input.width - input.left - input.right)));
    return Math.min(input.endLimit, input.from + ratio * (input.to - input.from));
  };
  return {
    draft: input.onSelect ? draft : null,
    cancel: () => setDraft(null),
    down: (event: PointerEvent<SVGSVGElement>) => {
      if (!input.onSelect || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const start = time(event); setDraft({ start, end: start, pointerX: event.clientX });
    },
    move: (event: PointerEvent<SVGSVGElement>) => {
      if (input.onSelect && draft) setDraft({ ...draft, end: time(event) });
    },
    up: (event: PointerEvent<SVGSVGElement>) => {
      if (!input.onSelect || !draft) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (Math.abs(event.clientX - draft.pointerX) < 4) { setDraft(null); return; }
      const last = time(event);
      const start = Math.max(input.from, Math.floor(Math.min(draft.start, last) / 60_000) * 60_000);
      const end = Math.min(input.endLimit, Math.ceil(Math.max(draft.start, last) / 60_000) * 60_000);
      setDraft(null);
      if (end - start >= 60_000) input.onSelect({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    },
  };
}
