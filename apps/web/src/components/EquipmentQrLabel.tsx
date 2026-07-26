import { useMemo, useState } from "react";
import type { AreaEquipment } from "@climate-twin/contracts";
import { Copy, Printer, QrCode } from "lucide-react";
import { useI18n } from "../i18n";
import { qrCodeMatrix } from "../qrCode";

export function equipmentQrPayload(propertyId: string, equipmentId: string): string {
  const query = new URLSearchParams({ property: propertyId, id: equipmentId, v: "1" });
  return `stuga://equipment?${query.toString()}`;
}

export function EquipmentQrLabel({
  equipment,
  propertyName,
  locationLabel,
}: Readonly<{
  equipment: AreaEquipment;
  propertyName: string;
  locationLabel: string;
}>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const payload = useMemo(
    () => equipmentQrPayload(equipment.propertyId, equipment.id),
    [equipment.id, equipment.propertyId],
  );
  const matrix = useMemo(() => {
    try {
      return qrCodeMatrix(payload);
    } catch {
      return null;
    }
  }, [payload]);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(payload);
    setCopied(true);
  };

  if (!matrix) return <p className="inline-error" role="alert">{t("properties.equipmentQrUnavailable")}</p>;
  return <section className="equipment-label-card" aria-labelledby={`equipment-label-${equipment.id}`}>
    <svg
      className="equipment-label-qr"
      viewBox={`-4 -4 ${matrix.length + 8} ${matrix.length + 8}`}
      role="img"
      aria-label={t("properties.equipmentQrAria", { equipment: equipment.name })}
      shapeRendering="crispEdges"
    >
      <rect x="-4" y="-4" width={matrix.length + 8} height={matrix.length + 8} fill="white" />
      {matrix.flatMap((row, y) => row.map((dark, x) => dark
        ? <rect key={`${x}:${y}`} x={x} y={y} width="1" height="1" fill="black" />
        : null))}
    </svg>
    <div className="equipment-label-copy">
      <span className="eyebrow"><QrCode size={14} aria-hidden="true" />{t("properties.equipmentQrLabel")}</span>
      <h3 id={`equipment-label-${equipment.id}`}>{equipment.name}</h3>
      <p>{propertyName} · {locationLabel}</p>
      <code>{payload}</code>
      <small>{t("properties.equipmentQrHelp")}</small>
    </div>
    <div className="equipment-label-actions">
      <button type="button" className="secondary-button" onClick={() => void copy()}>
        <Copy size={14} aria-hidden="true" />
        {copied ? t("properties.equipmentQrCopied") : t("properties.equipmentQrCopy")}
      </button>
      <button type="button" className="primary-button" onClick={() => window.print()}>
        <Printer size={14} aria-hidden="true" />
        {t("properties.equipmentQrPrint")}
      </button>
    </div>
  </section>;
}
