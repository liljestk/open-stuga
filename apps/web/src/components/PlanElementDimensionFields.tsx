import { useEffect, useState } from "react";
import type { DimensionBounds } from "../planElementGeometry";

interface DimensionControlProps {
  label: string;
  unit: string;
  value: number;
  bounds: DimensionBounds;
  onChange: (value: number) => boolean | void;
}

function precisionFor(step: number): number {
  if (step >= 1) return 1;
  if (step >= .1) return 2;
  return 3;
}

function formatValue(value: number, step: number): string {
  return Number(value.toFixed(precisionFor(step))).toString();
}

function inputValue(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

function DimensionControl({ label, unit, value, bounds, onChange }: DimensionControlProps) {
  const [draft, setDraft] = useState(() => inputValue(value));

  useEffect(() => {
    setDraft(inputValue(value));
  }, [value]);

  const apply = (next: number) => {
    if (!Number.isFinite(next) || next < bounds.min || next > bounds.max) return false;
    const accepted = onChange(next) !== false;
    if (!accepted) setDraft(inputValue(value));
    return accepted;
  };

  return (
    <div className="element-dimension-control" role="group" aria-label={label}>
      <span><span>{label}</span><output>{formatValue(value, bounds.step)} {unit}</output></span>
      <span className="element-dimension-inputs">
        <input
          type="range" min={bounds.min} max={bounds.max} step={bounds.step} value={value}
          aria-label={`${label} slider`}
          onChange={(event) => { const next = event.currentTarget.valueAsNumber; setDraft(event.currentTarget.value); apply(next); }}
        />
        <span className="dimension-number-wrap">
          <input
            type="number" min={bounds.min} max={bounds.max} step={bounds.step} value={draft}
            aria-label={label}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              apply(event.currentTarget.valueAsNumber);
            }}
            onBlur={(event) => {
              if (!apply(event.currentTarget.valueAsNumber)) setDraft(inputValue(value));
            }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <span aria-hidden="true">{unit}</span>
        </span>
      </span>
    </div>
  );
}

export interface PlanElementDimensionFieldsProps {
  widthLabel: string;
  heightLabel: string;
  planUnitLabel: string;
  metreLabel: string;
  width: number;
  height: number;
  widthBounds: DimensionBounds;
  heightBounds: DimensionBounds;
  onWidthChange: (width: number) => boolean | void;
  onHeightChange: (height: number) => boolean | void;
}

export function PlanElementDimensionFields(props: PlanElementDimensionFieldsProps) {
  return (
    <div className="element-dimension-fields">
      <DimensionControl
        label={props.widthLabel} unit={props.planUnitLabel} value={props.width}
        bounds={props.widthBounds} onChange={props.onWidthChange}
      />
      <DimensionControl
        label={props.heightLabel} unit={props.metreLabel} value={props.height}
        bounds={props.heightBounds} onChange={props.onHeightChange}
      />
    </div>
  );
}
