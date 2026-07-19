import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";
import { useI18n } from "../i18n";

const mapInformationPreferenceKey = "climate-twin-map-information";

export function useMapInformationVisibility() {
  const [expanded, setExpanded] = useState(() => {
    const preference = readLocalStorage(mapInformationPreferenceKey);
    if (preference) return preference === "expanded";
    return !(globalThis.matchMedia?.("(max-width: 680px)").matches ?? false);
  });

  const setMapInformationExpanded = (next: boolean) => {
    setExpanded(next);
    writeLocalStorage(mapInformationPreferenceKey, next ? "expanded" : "collapsed");
  };

  return { expanded, setMapInformationExpanded };
}

interface MapInformationToggleProps {
  controls: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export function MapInformationToggle({ controls, expanded, onExpandedChange }: Readonly<MapInformationToggleProps>) {
  const { t } = useI18n();
  const label = expanded ? t("twin.hideMapInformation") : t("twin.showMapInformation");
  return <button
    type="button"
    className={`map-information-toggle ${expanded ? "expanded" : "collapsed"}`}
    aria-controls={controls}
    aria-expanded={expanded}
    aria-label={label}
    title={label}
    onClick={() => onExpandedChange(!expanded)}
  >
    {expanded ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
    {!expanded && <span>{t("twin.mapInformation")}</span>}
  </button>;
}
