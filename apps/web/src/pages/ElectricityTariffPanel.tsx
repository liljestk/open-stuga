import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  ElectricityRateSchedule,
  ElectricityRateScheduleKind,
  ElectricityTariffVersion,
} from "@climate-twin/contracts";
import { api, ApiRequestError } from "../api";
import { queryClient } from "../data/queryClient";
import { queryKeys } from "../data/queryKeys";
import { useI18n } from "../i18n";
import "./ElectricityTariffPanel.css";
import { CardHeader } from "../components/CardHeader";

type ScheduleChoice = ElectricityRateScheduleKind | "none";

interface ScheduleDraft {
  kind: ScheduleChoice;
  primary: string;
  secondary: string;
}

interface VersionDraft {
  validFrom: string;
  energyKind: "spot" | "fixed" | "none";
  margin: string;
  energySchedule: ScheduleDraft;
  network: ScheduleDraft;
  tax: string;
  retailerFee: string;
  networkFee: string;
}

const text = (value: number | null | undefined): string => value === null || value === undefined ? "" : String(value);

function scheduleDraft(schedule: ElectricityRateSchedule | null): ScheduleDraft {
  if (!schedule) return { kind: "none", primary: "", secondary: "" };
  switch (schedule.kind) {
    case "flat": return { kind: "flat", primary: text(schedule.centsPerKwh), secondary: "" };
    case "day_night": return { kind: "day_night", primary: text(schedule.dayCentsPerKwh), secondary: text(schedule.nightCentsPerKwh) };
    case "seasonal": return { kind: "seasonal", primary: text(schedule.winterDayCentsPerKwh), secondary: text(schedule.otherCentsPerKwh) };
  }
}

function versionDraft(version: ElectricityTariffVersion): VersionDraft {
  return {
    validFrom: version.validFrom,
    energyKind: version.energy?.kind ?? "none",
    margin: version.energy?.kind === "spot" ? text(version.energy.marginCentsPerKwh) : "0",
    energySchedule: version.energy?.kind === "fixed" ? scheduleDraft(version.energy.schedule) : { kind: "flat", primary: "", secondary: "" },
    network: scheduleDraft(version.network),
    tax: text(version.electricityTaxCentsPerKwh),
    retailerFee: text(version.retailerMonthlyFeeEur),
    networkFee: text(version.networkMonthlyFeeEur),
  };
}

/** Parses an optional number field; undefined marks an invalid entry. */
function optionalNumber(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredNumber(value: string): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === null ? undefined : parsed;
}

function scheduleFromDraft(draft: ScheduleDraft): ElectricityRateSchedule | null | undefined {
  if (draft.kind === "none") return null;
  const primary = requiredNumber(draft.primary);
  if (primary === undefined) return undefined;
  if (draft.kind === "flat") return { kind: "flat", centsPerKwh: primary };
  const secondary = requiredNumber(draft.secondary);
  if (secondary === undefined) return undefined;
  return draft.kind === "day_night"
    ? { kind: "day_night", dayCentsPerKwh: primary, nightCentsPerKwh: secondary }
    : { kind: "seasonal", winterDayCentsPerKwh: primary, otherCentsPerKwh: secondary };
}

function versionFromDraft(draft: VersionDraft): ElectricityTariffVersion | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom)) return null;
  let energy: ElectricityTariffVersion["energy"] = null;
  if (draft.energyKind === "spot") {
    const margin = requiredNumber(draft.margin);
    if (margin === undefined) return null;
    energy = { kind: "spot", marginCentsPerKwh: margin };
  } else if (draft.energyKind === "fixed") {
    const schedule = scheduleFromDraft(draft.energySchedule);
    if (!schedule) return null;
    energy = { kind: "fixed", schedule };
  }
  const network = scheduleFromDraft(draft.network);
  const tax = optionalNumber(draft.tax);
  const retailerFee = optionalNumber(draft.retailerFee);
  const networkFee = optionalNumber(draft.networkFee);
  if (network === undefined || tax === undefined || retailerFee === undefined || networkFee === undefined) return null;
  return {
    validFrom: draft.validFrom,
    energy,
    network,
    electricityTaxCentsPerKwh: tax,
    retailerMonthlyFeeEur: retailerFee,
    networkMonthlyFeeEur: networkFee,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ElectricityTariffPanelProps {
  propertyId: string;
  readOnly: boolean;
}

export function ElectricityTariffPanel({ propertyId, readOnly }: ElectricityTariffPanelProps) {
  const { locale, t } = useI18n();
  const query = useQuery({
    queryKey: queryKeys.electricityTariff(propertyId),
    queryFn: ({ signal }) => api.propertyElectricityTariff(propertyId, signal),
    enabled: Boolean(propertyId),
    staleTime: 60_000,
  }, queryClient);
  const [versions, setVersions] = useState<ElectricityTariffVersion[] | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; draft: VersionDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const loaded = query.data?.tariff ?? null;

  useEffect(() => {
    setVersions(null);
    setEditing(null);
    setFeedback(null);
  }, [propertyId]);

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const shown = versions ?? loaded?.versions ?? [];
  const dirty = versions !== null;

  const scheduleText = (schedule: ElectricityRateSchedule | null): string => {
    if (!schedule) return t("tariff.value.none");
    switch (schedule.kind) {
      case "flat": return t("tariff.value.flat", { rate: number.format(schedule.centsPerKwh) });
      case "day_night": return t("tariff.value.dayNight", {
        day: number.format(schedule.dayCentsPerKwh), night: number.format(schedule.nightCentsPerKwh),
      });
      case "seasonal": return t("tariff.value.seasonal", {
        winter: number.format(schedule.winterDayCentsPerKwh), other: number.format(schedule.otherCentsPerKwh),
      });
    }
  };
  const energyText = (version: ElectricityTariffVersion): string => {
    if (!version.energy) return t("tariff.value.missing");
    return version.energy.kind === "spot"
      ? t("tariff.value.spot", { margin: number.format(version.energy.marginCentsPerKwh) })
      : scheduleText(version.energy.schedule);
  };
  const feesText = (version: ElectricityTariffVersion): string => (
    version.retailerMonthlyFeeEur === null && version.networkMonthlyFeeEur === null
      ? t("tariff.value.none")
      : t("tariff.value.fees", {
        retailer: money.format(version.retailerMonthlyFeeEur ?? 0),
        network: money.format(version.networkMonthlyFeeEur ?? 0),
      })
  );

  const applyDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const version = versionFromDraft(editing.draft);
    if (!version) {
      setFeedback({ kind: "error", text: t("tariff.invalidNumbers") });
      return;
    }
    const others = shown.filter((_, index) => index !== editing.index);
    if (others.some((candidate) => candidate.validFrom === version.validFrom)) {
      setFeedback({ kind: "error", text: t("tariff.duplicateDate", { date: version.validFrom }) });
      return;
    }
    setVersions([...others, version].sort((left, right) => left.validFrom.localeCompare(right.validFrom)));
    setEditing(null);
    setFeedback(null);
  };

  const remove = (index: number) => {
    if (shown.length <= 1) {
      setFeedback({ kind: "error", text: t("tariff.lastVersion") });
      return;
    }
    setVersions(shown.filter((_, candidate) => candidate !== index));
  };

  const save = async () => {
    if (!versions || !loaded || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const saved = await api.savePropertyElectricityTariff(propertyId, versions, loaded.revision);
      queryClient.setQueryData(queryKeys.electricityTariff(propertyId), saved);
      setVersions(null);
      setFeedback({ kind: "success", text: t("tariff.saved") });
      // Costs and effective prices depend on the tariff.
      void queryClient.invalidateQueries({ queryKey: ["house"] });
      void queryClient.invalidateQueries({ queryKey: ["property", propertyId] });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        // Another session saved first; reload so the next save starts from its revision.
        void query.refetch();
        setFeedback({ kind: "error", text: t("tariff.conflict") });
      } else {
        setFeedback({ kind: "error", text: t("tariff.saveError", { message: error instanceof Error ? error.message : String(error) }) });
      }
    } finally {
      setBusy(false);
    }
  };

  const draftField = (key: keyof VersionDraft, value: string) => setEditing((current) => current && ({
    ...current, draft: { ...current.draft, [key]: value },
  }));
  const scheduleField = (key: "energySchedule" | "network", patch: Partial<ScheduleDraft>) => setEditing((current) => current && ({
    ...current, draft: { ...current.draft, [key]: { ...current.draft[key], ...patch } },
  }));
  const scheduleInputs = (key: "energySchedule" | "network", draft: ScheduleDraft) => draft.kind === "none" ? null : <>
    <label className="field"><span>{t(draft.kind === "flat" ? "tariff.field.flatRate" : draft.kind === "day_night" ? "tariff.field.dayRate" : "tariff.field.winterDayRate")}</span>
      <input inputMode="decimal" required value={draft.primary} onChange={(event) => scheduleField(key, { primary: event.target.value })} /></label>
    {draft.kind !== "flat" && <label className="field"><span>{t(draft.kind === "day_night" ? "tariff.field.nightRate" : "tariff.field.otherRate")}</span>
      <input inputMode="decimal" required value={draft.secondary} onChange={(event) => scheduleField(key, { secondary: event.target.value })} /></label>}
  </>;
  const scheduleSelect = (key: "energySchedule" | "network", label: string, draft: ScheduleDraft, allowNone: boolean) => (
    <label className="field"><span>{label}</span>
      <select value={draft.kind} onChange={(event) => scheduleField(key, { kind: event.target.value as ScheduleChoice })}>
        {allowNone && <option value="none">{t("tariff.schedule.none")}</option>}
        <option value="flat">{t("tariff.schedule.flat")}</option>
        <option value="day_night">{t("tariff.schedule.day_night")}</option>
        <option value="seasonal">{t("tariff.schedule.seasonal")}</option>
      </select>
    </label>
  );

  return (
    <section className="panel electricity-tariff" aria-labelledby="electricity-tariff-heading">
      <CardHeader title={t("tariff.title")} eyebrow={t("tariff.eyebrow")} titleId="electricity-tariff-heading" />
      <p>{t("tariff.description")}</p>
      {query.data && <p className="electricity-tariff-note">{t("tariff.timeZone", { timeZone: query.data.timeZone })}</p>}
      {query.isPending && <p role="status">{t("tariff.loading")}</p>}
      {query.isError && <p role="alert">{t("tariff.loadError")}</p>}
      {loaded?.revision === 0 && !dirty && <p className="electricity-tariff-note">{t("tariff.legacy")}</p>}
      {shown.some((version) => version.energy === null) && <p className="energy-waiting" role="status">{t("tariff.energyMissingWarning")}</p>}
      {shown.length > 0 && <div className="energy-table-scroll" role="region" aria-labelledby="electricity-tariff-heading" tabIndex={0}>
        <table className="electricity-tariff-table">
          <thead><tr>
            <th scope="col">{t("tariff.column.validFrom")}</th><th scope="col">{t("tariff.column.energy")}</th>
            <th scope="col">{t("tariff.column.network")}</th><th scope="col">{t("tariff.column.tax")}</th>
            <th scope="col">{t("tariff.column.fees")}</th>{!readOnly && <th scope="col">{t("tariff.column.actions")}</th>}
          </tr></thead>
          <tbody>{shown.map((version, index) => <tr key={version.validFrom}>
            <th scope="row">{version.validFrom}</th>
            <td>{energyText(version)}</td>
            <td>{scheduleText(version.network)}</td>
            <td>{version.electricityTaxCentsPerKwh === null ? t("tariff.value.none") : t("tariff.value.flat", { rate: number.format(version.electricityTaxCentsPerKwh) })}</td>
            <td>{feesText(version)}</td>
            {!readOnly && <td className="electricity-tariff-actions">
              <button type="button" className="secondary-button" onClick={() => setEditing({ index, draft: versionDraft(version) })}><Pencil size={14} aria-hidden="true" />{t("tariff.edit")}</button>
              <button type="button" className="secondary-button" onClick={() => remove(index)}><Trash2 size={14} aria-hidden="true" />{t("tariff.remove")}</button>
            </td>}
          </tr>)}</tbody>
        </table>
      </div>}
      {!readOnly && loaded && <div className="electricity-tariff-toolbar">
        <button type="button" className="secondary-button" onClick={() => setEditing({
          index: null,
          draft: { ...versionDraft(shown.at(-1) ?? loaded.versions[0]!), validFrom: today() },
        })}><Plus size={14} aria-hidden="true" />{t("tariff.add")}</button>
        {dirty && <span className="status-badge">{t("tariff.unsaved")}</span>}
        {dirty && <button type="button" className="secondary-button" onClick={() => { setVersions(null); setEditing(null); }}>{t("tariff.cancel")}</button>}
        <button type="button" className="primary-button" disabled={!dirty || busy} onClick={() => { void save(); }}>{busy ? t("tariff.saving") : t("tariff.save")}</button>
      </div>}
      {editing && <details className="energy-contract-editor" open>
        <summary><span>{t(editing.index === null ? "tariff.add" : "tariff.edit")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <form onSubmit={applyDraft} className="energy-source-controls">
          <label className="field"><span>{t("tariff.field.validFrom")}</span><input type="date" required value={editing.draft.validFrom} onChange={(event) => draftField("validFrom", event.target.value)} /></label>
          <label className="field"><span>{t("tariff.field.energyKind")}</span>
            <select value={editing.draft.energyKind} onChange={(event) => draftField("energyKind", event.target.value)}>
              <option value="spot">{t("tariff.energyKind.spot")}</option>
              <option value="fixed">{t("tariff.energyKind.fixed")}</option>
              <option value="none">{t("tariff.energyKind.none")}</option>
            </select>
          </label>
          {editing.draft.energyKind === "spot" && <label className="field"><span>{t("tariff.field.margin")}</span><input inputMode="decimal" required value={editing.draft.margin} onChange={(event) => draftField("margin", event.target.value)} /></label>}
          {editing.draft.energyKind === "fixed" && <>
            {scheduleSelect("energySchedule", t("tariff.field.schedule"), editing.draft.energySchedule, false)}
            {scheduleInputs("energySchedule", editing.draft.energySchedule)}
          </>}
          {scheduleSelect("network", t("tariff.field.networkSchedule"), editing.draft.network, true)}
          {scheduleInputs("network", editing.draft.network)}
          <label className="field"><span>{t("tariff.field.tax")}</span><input inputMode="decimal" value={editing.draft.tax} onChange={(event) => draftField("tax", event.target.value)} /></label>
          <label className="field"><span>{t("tariff.field.retailerFee")}</span><input inputMode="decimal" value={editing.draft.retailerFee} onChange={(event) => draftField("retailerFee", event.target.value)} /></label>
          <label className="field"><span>{t("tariff.field.networkFee")}</span><input inputMode="decimal" value={editing.draft.networkFee} onChange={(event) => draftField("networkFee", event.target.value)} /></label>
          <div className="electricity-tariff-toolbar">
            <button type="submit" className="primary-button">{t("tariff.apply")}</button>
            <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("tariff.cancel")}</button>
          </div>
        </form>
      </details>}
      {feedback && <p role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  );
}
