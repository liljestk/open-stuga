import { useRef, type KeyboardEvent, type ReactNode } from "react";
import "./Tabs.css";

export interface TabItem<Id extends string> {
  id: Id;
  label: ReactNode;
  /** A second line under the label, for tabs that summarise their section. */
  detail?: ReactNode;
  /** A short count shown as a pill after the label. */
  count?: ReactNode;
  icon?: ReactNode;
}

interface TabsProps<Id extends string> {
  label: string;
  items: readonly TabItem<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  tabId: (id: Id) => string;
  panelId: (id: Id) => string;
  className?: string;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

function targetIndex(key: string, index: number, length: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (NEXT_KEYS.has(key)) return (index + 1) % length;
  if (PREVIOUS_KEYS.has(key)) return (index - 1 + length) % length;
  return null;
}

/**
 * The one tab list: a roving tab stop, arrow keys (either axis), Home and End,
 * and the selection following focus, as the WAI-ARIA tabs pattern describes.
 */
export function Tabs<Id extends string>({ label, items, selected, onSelect, tabId, panelId, className = "" }: Readonly<TabsProps<Id>>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // A section outside the list (such as an advanced Set up section) still leaves the list one tab stop.
  const tabStop = items.some((item) => item.id === selected) ? selected : items[0]?.id;
  const chooseFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = targetIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    onSelect(items[next]!.id);
    buttons.current[next]?.focus();
  };
  return (
    <div className={`tabs ${className}`.trim()} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => { buttons.current[index] = node; }}
          id={tabId(item.id)}
          type="button"
          role="tab"
          className="tab"
          aria-selected={item.id === selected}
          aria-controls={panelId(item.id)}
          tabIndex={item.id === tabStop ? 0 : -1}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => chooseFromKeyboard(event, index)}
        >
          {item.icon}
          {item.detail === undefined ? item.label : <span className="tab-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>}
          {item.count !== undefined && <span className="tab-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
