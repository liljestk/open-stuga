import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalyticsAggregation,
  AnalyticsResolution,
  ExportDestinationStatus,
  House,
  ScheduledDataExport,
  ScheduledDataExportFrequency,
  ScheduledDataExportInput,
} from "@climate-twin/contracts";
import { CalendarClock, Cloud, HardDrive, LoaderCircle, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { confirmAction } from "./ConfirmationProvider";
import { EXPORT_DESTINATION_NAME_KEYS } from "./exportDestinationNames";
import { useI18n } from "../i18n";
import "./ScheduledDataExportsPanel.css";

type ExportPeriod = "24h" | "7d" | "30d" | "90d" | "custom";

interface ScheduledDataExportsPanelProps {
  house: House;
  period: ExportPeriod;
  sensorIds: string[];
  measurementIds: string[];
  resolution: AnalyticsResolution | null;
  aggregation: AnalyticsAggregation;
  configurationError: string | null;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function scheduleInput(schedule: ScheduledDataExport, enabled = schedule.enabled): ScheduledDataExportInput {
  return {
    name: schedule.name,
    enabled,
    frequency: schedule.frequency,
    timeLocal: schedule.timeLocal,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    period: schedule.period,
    sensorIds: schedule.sensorIds,
    measurementIds: schedule.measurementIds,
    resolution: schedule.resolution,
    aggregation: schedule.aggregation,
    retentionCount: schedule.retentionCount,
  };
}

export function ScheduledDataExportsPanel(props: Readonly<ScheduledDataExportsPanelProps>) {
  const { locale, t } = useI18n();
  const [schedules, setSchedules] = useState<ScheduledDataExport[]>([]);
  const [destination, setDestination] = useState<ExportDestinationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [storageLoadError, setStorageLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState(`${props.house.name} export`);
  const [frequency, setFrequency] = useState<ScheduledDataExportFrequency>("weekly");
  const [timeLocal, setTimeLocal] = useState("02:00");
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [retentionCount, setRetentionCount] = useState(12);
  const schedulesInFlight = useRef<{ houseId: string; controller: AbortController; promise: Promise<void> } | null>(null);
  const storageInFlight = useRef<{ houseId: string; controller: AbortController; promise: Promise<void> } | null>(null);

  const loadSchedules = useCallback((quiet = false): Promise<void> => {
    if (schedulesInFlight.current?.houseId === props.house.id) return schedulesInFlight.current.promise;
    if (schedulesInFlight.current) {
      schedulesInFlight.current.controller.abort();
      schedulesInFlight.current = null;
    }
    if (!quiet) setLoading(true);
    const controller = new AbortController();
    const task = api.scheduledDataExports(props.house.id, controller.signal).then((nextSchedules) => {
      if (controller.signal.aborted) return;
      setSchedules(nextSchedules);
      setScheduleLoadError(null);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setScheduleLoadError(message(loadError, t("dataExport.scheduleLoadError")));
    }).finally(() => {
      if (!quiet && !controller.signal.aborted) setLoading(false);
      if (schedulesInFlight.current?.promise === task) schedulesInFlight.current = null;
    });
    schedulesInFlight.current = { houseId: props.house.id, controller, promise: task };
    return task;
  }, [props.house.id, t]);

  const loadStorage = useCallback((): Promise<void> => {
    if (storageInFlight.current?.houseId === props.house.id) return storageInFlight.current.promise;
    if (storageInFlight.current) {
      storageInFlight.current.controller.abort();
      storageInFlight.current = null;
    }
    const controller = new AbortController();
    const task = api.exportDestinations(controller.signal).then((nextDestination) => {
      if (controller.signal.aborted) return;
      setDestination(nextDestination);
      setStorageLoadError(null);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setStorageLoadError(message(loadError, t("dataExport.scheduleLoadError")));
    }).finally(() => {
      if (storageInFlight.current?.promise === task) storageInFlight.current = null;
    });
    storageInFlight.current = { houseId: props.house.id, controller, promise: task };
    return task;
  }, [props.house.id, t]);

  useEffect(() => {
    setSchedules([]);
    setDestination(null);
    setScheduleLoadError(null);
    setStorageLoadError(null);
    setActionError(null);
    void loadSchedules();
    void loadStorage();
    return () => {
      schedulesInFlight.current?.controller.abort();
      storageInFlight.current?.controller.abort();
      schedulesInFlight.current = null;
      storageInFlight.current = null;
    };
  }, [loadSchedules, loadStorage]);
  useEffect(() => setName(`${props.house.name} export`), [props.house.id, props.house.name]);
  useEffect(() => {
    if (!schedules.some((schedule) => schedule.lastRunStatus === "pending")) return;
    let stopped = false;
    let timer: number | null = null;
    const pollAfterDelay = () => {
      timer = window.setTimeout(() => {
        void loadSchedules(true).finally(() => {
          if (!stopped) pollAfterDelay();
        });
      }, 3_000);
    };
    pollAfterDelay();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadSchedules, schedules]);

  const selectedInput = (selectedFrequency: ScheduledDataExportFrequency, selectedName: string): ScheduledDataExportInput | null => {
    if (props.period === "custom" || !props.resolution || props.resolution === "auto") return null;
    return {
      name: selectedName.trim(),
      enabled: true,
      frequency: selectedFrequency,
      timeLocal,
      dayOfWeek: selectedFrequency === "weekly" ? dayOfWeek : null,
      dayOfMonth: selectedFrequency === "monthly" ? dayOfMonth : null,
      period: props.period,
      sensorIds: props.sensorIds,
      measurementIds: props.measurementIds,
      resolution: props.resolution,
      aggregation: props.resolution === "raw" ? "default" : props.aggregation,
      retentionCount,
    };
  };

  const selectionError = props.configurationError
    ?? (props.period === "custom" ? t("dataExport.scheduleCustomPeriod") : null);
  const targetReady = destination === null ? null : destination.ready;
  const canCreate = targetReady === true && !selectionError && busy === null;
  const error = actionError ?? scheduleLoadError ?? storageLoadError;

  const create = async (selectedFrequency: ScheduledDataExportFrequency, selectedName: string) => {
    const input = selectedInput(selectedFrequency, selectedName);
    if (!input) return;
    setBusy("create");
    setActionError(null);
    try {
      const created = await api.createScheduledDataExport(props.house.id, input);
      setSchedules((current) => [...current, created]);
    } catch (createError) {
      setActionError(message(createError, t("dataExport.scheduleSaveError")));
    } finally {
      setBusy(null);
    }
  };

  const run = async (schedule: ScheduledDataExport) => {
    setBusy(schedule.id);
    setActionError(null);
    try {
      const updated = await api.runScheduledDataExport(props.house.id, schedule.id);
      setSchedules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (runError) {
      setActionError(message(runError, t("dataExport.scheduleRunError")));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (schedule: ScheduledDataExport) => {
    setBusy(schedule.id);
    setActionError(null);
    try {
      const updated = await api.updateScheduledDataExport(props.house.id, schedule.id, {
        ...scheduleInput(schedule, !schedule.enabled),
        baseRevision: schedule.revision,
      });
      setSchedules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (updateError) {
      setActionError(message(updateError, t("dataExport.scheduleSaveError")));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (schedule: ScheduledDataExport) => {
    if (!await confirmAction(t("dataExport.scheduleDeleteConfirm", { name: schedule.name }), t("dataExport.scheduleDelete"), true)) return;
    setBusy(schedule.id);
    setActionError(null);
    try {
      await api.deleteScheduledDataExport(props.house.id, schedule.id);
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
    } catch (deleteError) {
      setActionError(message(deleteError, t("dataExport.scheduleDeleteError")));
    } finally {
      setBusy(null);
    }
  };

  const formatDate = (value: string | null) => value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: props.house.timezone }).format(new Date(value))
    : t("dataExport.scheduleNever");
  const frequencyLabel = (value: ScheduledDataExportFrequency) => value === "daily"
    ? t("dataExport.scheduleDaily") : value === "weekly" ? t("dataExport.scheduleWeekly") : t("dataExport.scheduleMonthly");
  const recurrenceLabel = (schedule: ScheduledDataExport) => {
    if (schedule.frequency === "weekly" && schedule.dayOfWeek !== null) {
      const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(2024, 0, 7 + schedule.dayOfWeek)));
      return `${frequencyLabel(schedule.frequency)} · ${weekday}`;
    }
    if (schedule.frequency === "monthly" && schedule.dayOfMonth !== null) {
      return `${frequencyLabel(schedule.frequency)} · ${t("dataExport.scheduleMonthlyOn", { day: schedule.dayOfMonth })}`;
    }
    return frequencyLabel(schedule.frequency);
  };
  const statusLabel = (schedule: ScheduledDataExport) => schedule.lastRunStatus === "pending"
    ? t("dataExport.schedulePending") : schedule.lastRunStatus === "complete" ? t("dataExport.scheduleComplete")
      : schedule.lastRunStatus === "failed" ? t("dataExport.scheduleFailed") : t("dataExport.scheduleNever");

  return <section className="scheduled-data-exports" aria-labelledby="scheduled-data-exports-title">
    <header>
      <div><span className="eyebrow"><CalendarClock size={14} aria-hidden="true" /> {t("dataExport.scheduleEyebrow")}</span><h3 id="scheduled-data-exports-title">{t("dataExport.scheduleTitle")}</h3><p>{t("dataExport.scheduleDescription")}</p></div>
      <span className={`scheduled-target ${targetReady ? "connected" : "missing"}`}>{destination?.selected && destination.selected !== "nas" ? <Cloud size={14} aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}{destination === null ? t("dataExport.scheduleTargetChecking") : targetReady ? t("dataExport.scheduleTargetConnected", { destination: t(EXPORT_DESTINATION_NAME_KEYS[destination.selected]) }) : t("dataExport.scheduleTargetMissing")}</span>
    </header>

    {targetReady === false && <div className="scheduled-target-callout"><p>{t("dataExport.scheduleTargetHelp")}</p><a className="secondary-button" href="/setup/operations#nas-export-setup">{t("dataExport.scheduleSetupNas")}</a></div>}

    <div className="scheduled-quick-create">
      <div><strong>{t("dataExport.scheduleUsingSelection")}</strong><small>{t("dataExport.scheduleCsvOnly")}</small></div>
      <button type="button" className="primary-button" disabled={!canCreate} onClick={() => void create("weekly", `${props.house.name} weekly export`)}>{busy === "create" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}{t("dataExport.scheduleQuickAction")}</button>
    </div>
    {selectionError && <p className="scheduled-selection-note">{selectionError}</p>}

    <details className="scheduled-advanced">
      <summary>{t("dataExport.scheduleAdvanced")}</summary>
      <div className="scheduled-advanced-fields">
        <label className="field"><span>{t("dataExport.scheduleName")}</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>{t("dataExport.scheduleFrequency")}</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as ScheduledDataExportFrequency)}><option value="daily">{t("dataExport.scheduleDaily")}</option><option value="weekly">{t("dataExport.scheduleWeekly")}</option><option value="monthly">{t("dataExport.scheduleMonthly")}</option></select></label>
        <label className="field"><span>{t("dataExport.scheduleTime")}</span><input type="time" value={timeLocal} onChange={(event) => setTimeLocal(event.target.value)} /></label>
        {frequency === "weekly" && <label className="field"><span>{t("dataExport.scheduleWeekday")}</span><select value={dayOfWeek} onChange={(event) => setDayOfWeek(Number(event.target.value))}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + index)))}</option>)}</select></label>}
        {frequency === "monthly" && <label className="field"><span>{t("dataExport.scheduleMonthDay")}</span><input type="number" min="1" max="31" value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))} /></label>}
        <label className="field"><span>{t("dataExport.scheduleRetention")}</span><input type="number" min="1" max="365" value={retentionCount} onChange={(event) => setRetentionCount(Number(event.target.value))} /><small>{t("dataExport.scheduleRetentionHelp")}</small></label>
      </div>
      {!name.trim() && <p className="scheduled-selection-note">{t("dataExport.scheduleNameRequired")}</p>}
      <button type="button" className="primary-button" disabled={!canCreate || !name.trim()} onClick={() => void create(frequency, name)}>{busy === "create" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}{t("dataExport.scheduleCreate")}</button>
    </details>

    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && schedules.length === 0 ? <p className="scheduled-loading" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("dataExport.scheduleLoading")}</p> : schedules.length === 0 ? <p className="scheduled-empty">{t("dataExport.scheduleEmpty")}</p> : <ul className="scheduled-list">{schedules.map((schedule) => <li key={schedule.id}>
      <div className="scheduled-list-main"><strong>{schedule.name}</strong><span>{recurrenceLabel(schedule)} · {schedule.timeLocal} · {schedule.period}</span><small>{t("dataExport.scheduleNextRun")}: {schedule.enabled ? formatDate(schedule.nextRunAt) : t("dataExport.schedulePaused")} · {t("dataExport.scheduleLastRun")}: {statusLabel(schedule)}</small>{schedule.lastOutputName && <small>{t("dataExport.scheduleLastFile")}: <code>{schedule.lastOutputName}</code></small>}{schedule.lastRunError && <small className="scheduled-run-error">{schedule.lastRunError}</small>}</div>
      <div className="scheduled-actions"><button type="button" className="icon-button" title={t("dataExport.scheduleRunNow")} aria-label={t("dataExport.scheduleRunNow")} disabled={busy !== null || schedule.lastRunStatus === "pending"} onClick={() => void run(schedule)}><Play size={15} aria-hidden="true" /></button><button type="button" className="icon-button" title={schedule.enabled ? t("dataExport.schedulePause") : t("dataExport.scheduleResume")} aria-label={schedule.enabled ? t("dataExport.schedulePause") : t("dataExport.scheduleResume")} disabled={busy !== null || schedule.lastRunStatus === "pending"} onClick={() => void toggle(schedule)}>{schedule.enabled ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button><button type="button" className="icon-button danger" title={t("dataExport.scheduleDelete")} aria-label={t("dataExport.scheduleDelete")} disabled={busy !== null || schedule.lastRunStatus === "pending"} onClick={() => void remove(schedule)}><Trash2 size={15} aria-hidden="true" /></button></div>
    </li>)}</ul>}
  </section>;
}
