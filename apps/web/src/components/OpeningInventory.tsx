import { configuredPlanElementOpeningState, type AirflowPlanElement, type Floor } from "@climate-twin/contracts";
import { useI18n, type TranslationKey } from "../i18n";

interface OpeningInventoryProps {
  floors: readonly Floor[];
  selected?: { floorId: string; elementId: string } | null;
  onSelect: (floorId: string, elementId: string) => void;
}

function defaultVariant(element: AirflowPlanElement) {
  if (element.kind === "door") return "interior";
  if (element.kind === "window") return "casement";
  return "passive";
}

/** A compact instance inventory shared by the 2D and 3D house editors. */
export function OpeningInventory({ floors, selected = null, onSelect }: OpeningInventoryProps) {
  const { t } = useI18n();
  const entries = floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element, index) => element.kind === "fireplace" ? [] : [{ floor, element, index }]));
  return <details className="opening-inventory">
    <summary><span>{t("opening.inventory")}</span><small>{t("opening.inventoryCount", { count: entries.length })}</small></summary>
    {entries.length
      ? <div className="opening-inventory-list">{entries.map(({ floor, element, index }) => {
        const state = configuredPlanElementOpeningState(element);
        const variant = element.variant ?? defaultVariant(element);
        const isSelected = selected?.floorId === floor.id && selected.elementId === element.id;
        return <button key={`${floor.id}:${element.id}`} type="button" className={isSelected ? "opening-inventory-item selected" : "opening-inventory-item"} aria-pressed={isSelected} onClick={() => onSelect(floor.id, element.id)}>
          <span className={`opening-state-swatch ${state.state}`} aria-hidden="true" />
          <span><strong>{element.label ?? `${t(`planElement.${element.kind}` as TranslationKey)} ${index + 1}`}</strong><small>{floors.length > 1 ? `${floor.name} \u00b7 ` : ""}{t(`opening.variant.${element.kind}.${variant}` as TranslationKey)}</small></span>
          <span className={`opening-state-label ${state.state}`}>{t(`opening.state.${state.state}` as TranslationKey)}</span>
        </button>;
      })}</div>
      : <p>{t("opening.inventoryEmpty")}</p>}
  </details>;
}
