import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ReceiptText, Trash2 } from "lucide-react";
import {
  ELECTRICITY_INVOICE_TOLERANCE_PERCENT,
  type ElectricityInvoice,
  type ElectricityInvoiceInput,
  type ElectricityInvoiceReconciliation,
  type House,
} from "@climate-twin/contracts";
import { api, ApiRequestError } from "../api";
import { confirmAction } from "../components/ConfirmationProvider";
import { queryClient } from "../data/queryClient";
import { queryKeys } from "../data/queryKeys";
import { useI18n } from "../i18n";
import "./ElectricityTariffPanel.css";

interface InvoiceDraft {
  houseId: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  kwh: string;
  energy: string;
  network: string;
  tax: string;
  fees: string;
  note: string;
}

type CheckState = { status: "loading" } | { status: "error" } | { status: "done"; result: ElectricityInvoiceReconciliation };

const COMPONENTS = ["energy", "network", "tax", "fees"] as const;

function emptyDraft(houseId: string): InvoiceDraft {
  return { houseId, periodStart: "", periodEnd: "", total: "", kwh: "", energy: "", network: "", tax: "", fees: "", note: "" };
}

/** Parses an optional amount; undefined marks an invalid entry. */
function amount(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function invoiceInput(draft: InvoiceDraft): ElectricityInvoiceInput | null {
  const total = amount(draft.total);
  const optional = [draft.kwh, draft.energy, draft.network, draft.tax, draft.fees].map(amount);
  if (!draft.houseId || !draft.periodStart || !draft.periodEnd || total === null || total === undefined
    || optional.some((value) => value === undefined)) return null;
  const [consumptionKwh, energyEur, networkEur, taxEur, feesEur] = optional as Array<number | null>;
  return {
    houseId: draft.houseId,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    totalEur: total,
    consumptionKwh: consumptionKwh ?? null,
    energyEur: energyEur ?? null,
    networkEur: networkEur ?? null,
    taxEur: taxEur ?? null,
    feesEur: feesEur ?? null,
    note: draft.note.trim() || null,
  };
}

interface ElectricityBillCheckPanelProps {
  propertyId: string;
  houses: readonly House[];
  readOnly: boolean;
}

export function ElectricityBillCheckPanel({ propertyId, houses, readOnly }: ElectricityBillCheckPanelProps) {
  const { locale, t } = useI18n();
  const query = useQuery({
    queryKey: queryKeys.electricityInvoices(propertyId),
    queryFn: ({ signal }) => api.electricityInvoices(propertyId, signal),
    enabled: Boolean(propertyId),
    staleTime: 60_000,
    retry: (failures, error) => !(error instanceof ApiRequestError && error.status === 403) && failures < 2,
  }, queryClient);
  const [draft, setDraft] = useState<InvoiceDraft>(() => emptyDraft(houses[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});

  useEffect(() => {
    setDraft(emptyDraft(houses[0]?.id ?? ""));
    setChecks({});
    setFeedback(null);
  }, [propertyId, houses[0]?.id]);

  // Invoices are owner data: a Guest's 403 hides the panel rather than showing a denial.
  if (query.error instanceof ApiRequestError && query.error.status === 403) return null;

  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const tolerance = number.format(ELECTRICITY_INVOICE_TOLERANCE_PERCENT);
  const formatMoney = (value: number | null) => value === null ? t("billCheck.notAvailable") : money.format(value);
  const formatError = (value: number | null) => value === null
    ? t("billCheck.notAvailable")
    : t("billCheck.errorPercent", { value: `${value > 0 ? "+" : ""}${number.format(value)}` });
  const homeName = (houseId: string) => houses.find((house) => house.id === houseId)?.name ?? houseId;
  const period = (invoice: ElectricityInvoice) => t("billCheck.period", { start: invoice.periodStart, end: invoice.periodEnd });

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = invoiceInput(draft);
    if (!input) {
      setFeedback({ kind: "error", text: t("billCheck.invalidNumbers") });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await api.createElectricityInvoice(propertyId, input);
      setDraft(emptyDraft(draft.houseId));
      setFeedback({ kind: "success", text: t("billCheck.added") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.electricityInvoices(propertyId) });
    } catch (error) {
      setFeedback({ kind: "error", text: t("billCheck.addError", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(false);
    }
  };

  const check = async (invoice: ElectricityInvoice) => {
    setChecks((current) => ({ ...current, [invoice.id]: { status: "loading" } }));
    try {
      const result = await api.reconcileElectricityInvoice(propertyId, invoice.id);
      setChecks((current) => ({ ...current, [invoice.id]: { status: "done", result } }));
    } catch {
      setChecks((current) => ({ ...current, [invoice.id]: { status: "error" } }));
    }
  };

  const remove = async (invoice: ElectricityInvoice) => {
    if (!await confirmAction(t("billCheck.deleteConfirm", { period: period(invoice) }), t("billCheck.delete"))) return;
    try {
      await api.deleteElectricityInvoice(propertyId, invoice.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.electricityInvoices(propertyId) });
    } catch {
      setFeedback({ kind: "error", text: t("billCheck.deleteError") });
    }
  };

  const field = (key: keyof InvoiceDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const amountInput = (key: keyof InvoiceDraft, label: string, required = false) => (
    <label className="field"><span>{label}</span><input inputMode="decimal" required={required} value={draft[key]} onChange={(event) => field(key, event.target.value)} /></label>
  );

  const result = (state: CheckState | undefined) => {
    if (!state) return null;
    if (state.status === "loading") return <p role="status">{t("billCheck.checking")}</p>;
    if (state.status === "error") return <p role="alert">{t("billCheck.checkError")}</p>;
    const reconciliation = state.result;
    return <div className="electricity-bill-result">
      <p><strong className={`electricity-bill-status ${reconciliation.status}`}>{t(`billCheck.status.${reconciliation.status}`, { tolerance })}</strong></p>
      <p>{reconciliation.total.calculatedEur === null
        ? t("billCheck.resultUnavailable")
        : t("billCheck.result", {
          calculated: formatMoney(reconciliation.total.calculatedEur),
          invoiced: formatMoney(reconciliation.total.invoicedEur),
          error: formatError(reconciliation.total.errorPercent),
        })}</p>
      {reconciliation.consumption && <p>{t("billCheck.consumptionLine", {
        calculated: reconciliation.consumption.calculatedKwh === null ? t("billCheck.notAvailable") : number.format(reconciliation.consumption.calculatedKwh),
        invoiced: number.format(reconciliation.consumption.invoicedKwh),
        error: formatError(reconciliation.consumption.errorPercent),
      })}</p>}
      {COMPONENTS.flatMap((component) => {
        const line = reconciliation.components[component];
        return line ? [<p key={component}>{t("billCheck.componentLine", {
          component: t(`billCheck.component.${component}`),
          calculated: formatMoney(line.calculatedEur),
          invoiced: formatMoney(line.invoicedEur),
          error: formatError(line.errorPercent),
        })}</p>] : [];
      })}
    </div>;
  };

  return (
    <section className="panel electricity-bill-check" aria-labelledby="electricity-bill-check-heading">
      <div className="panel-header"><div><span className="eyebrow"><ReceiptText size={14} aria-hidden="true" />{t("billCheck.eyebrow")}</span><h2 id="electricity-bill-check-heading">{t("billCheck.title")}</h2></div></div>
      <p>{t("billCheck.description", { tolerance })}</p>
      {query.isPending && <p role="status">{t("billCheck.loading")}</p>}
      {query.isError && <p role="alert">{t("billCheck.loadError")}</p>}
      {query.data?.length === 0 && <p>{t("billCheck.empty")}</p>}
      {query.data && query.data.length > 0 && <ul className="electricity-bill-results">{query.data.map((invoice) => <li key={invoice.id}>
        <span><strong>{period(invoice)}</strong> · {homeName(invoice.houseId)} · {t("billCheck.invoiced", { amount: money.format(invoice.totalEur) })}</span>
        <span className="electricity-tariff-actions">
          <button type="button" className="secondary-button" disabled={checks[invoice.id]?.status === "loading"} onClick={() => { void check(invoice); }}>{t("billCheck.check")}</button>
          {!readOnly && <button type="button" className="secondary-button" onClick={() => { void remove(invoice); }}><Trash2 size={14} aria-hidden="true" />{t("billCheck.delete")}</button>}
        </span>
        {result(checks[invoice.id])}
      </li>)}</ul>}
      {!readOnly && houses.length > 0 && <details className="energy-contract-editor">
        <summary><span>{t("billCheck.addTitle")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <form onSubmit={add} className="energy-source-controls">
          {houses.length > 1 && <label className="field"><span>{t("billCheck.field.home")}</span>
            <select value={draft.houseId} onChange={(event) => field("houseId", event.target.value)}>
              {houses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}
            </select>
          </label>}
          <label className="field"><span>{t("billCheck.field.periodStart")}</span><input type="date" required value={draft.periodStart} onChange={(event) => field("periodStart", event.target.value)} /></label>
          <label className="field"><span>{t("billCheck.field.periodEnd")}</span><input type="date" required value={draft.periodEnd} onChange={(event) => field("periodEnd", event.target.value)} /></label>
          {amountInput("total", t("billCheck.field.total"), true)}
          {amountInput("kwh", t("billCheck.field.kwh"))}
          {amountInput("energy", t("billCheck.field.energy"))}
          {amountInput("network", t("billCheck.field.network"))}
          {amountInput("tax", t("billCheck.field.tax"))}
          {amountInput("fees", t("billCheck.field.fees"))}
          <label className="field"><span>{t("billCheck.field.note")}</span><input maxLength={500} value={draft.note} onChange={(event) => field("note", event.target.value)} /></label>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? t("billCheck.adding") : t("billCheck.add")}</button>
        </form>
      </details>}
      {feedback && <p role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  );
}
