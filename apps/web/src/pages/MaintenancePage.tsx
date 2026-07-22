import { AlertTriangle, CalendarDays, Check, CheckCircle2, ChevronDown, Clock3, Edit3, History, LoaderCircle, Play, Plus, RotateCcw, Search, ShieldCheck, Wrench, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AreaEquipment,
  House,
  MaintenanceTask,
  MaintenanceTaskBasis,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskPriority,
  MaintenanceTaskRevision,
  ManualObservation,
  PropertyArea,
} from "@climate-twin/contracts";
import { ApiRequestError } from "../api";
import { formatInTimeZone } from "../dateTime";
import type { ClimateState } from "../domain";
import { useI18n, type TranslationKey } from "../i18n";
import { localObservationDate } from "../observationTime";
import "./OperationsPages.css";

const bases: MaintenanceTaskBasis[] = ["required", "scheduled", "condition-based", "predictive", "optional-improvement"];
const priorities: MaintenanceTaskPriority[] = ["low", "normal", "high", "urgent"];
type TaskFilter = "active" | "overdue" | "upcoming" | "in-progress" | "completed";

interface MaintenancePageProps {
  state: ClimateState;
  /** Legacy/default Home context. Property routes may omit this for land-only properties. */
  house?: House;
  propertyId?: string;
  houses?: House[];
  initialObservationId?: string | null;
  onSeedConsumed?: () => void;
  onCreateTask: (input: MaintenanceTaskInput) => Promise<MaintenanceTask>;
  onUpdateTask: (id: string, patch: MaintenanceTaskPatch) => Promise<MaintenanceTask>;
  onReloadTask: (id: string) => Promise<MaintenanceTask>;
  onLoadTaskRevisions: (id: string) => Promise<MaintenanceTaskRevision[]>;
  areas?: PropertyArea[];
  equipment?: AreaEquipment[];
  readOnly?: boolean;
}

function taskDate(task: MaintenanceTask): string | null {
  return task.dueBy ?? task.plannedFor;
}

function TaskEditor({ propertyId, houses, defaultHouseId, observations, areas, equipment, task, seedObservation, onCreate, onUpdate, onReload, onSaved, onCancel }: Readonly<{
  propertyId: string;
  houses: House[];
  defaultHouseId: string;
  observations: ManualObservation[];
  areas: PropertyArea[];
  equipment: AreaEquipment[];
  task?: MaintenanceTask;
  seedObservation?: ManualObservation;
  onCreate: (input: MaintenanceTaskInput) => Promise<MaintenanceTask>;
  onUpdate: (id: string, patch: MaintenanceTaskPatch) => Promise<MaintenanceTask>;
  onReload: (id: string) => Promise<MaintenanceTask>;
  onSaved: (task: MaintenanceTask) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const formId = useId();
  const [title, setTitle] = useState(task?.title ?? seedObservation?.note ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [basis, setBasis] = useState<MaintenanceTaskBasis>(task?.basis ?? (seedObservation ? "condition-based" : "scheduled"));
  const [basisDetail, setBasisDetail] = useState(task?.basisDetail ?? (seedObservation ? t("maintenance.basisFromObservation") : ""));
  const [priority, setPriority] = useState<MaintenanceTaskPriority>(task?.priority ?? (seedObservation?.severity === "critical" ? "urgent" : seedObservation?.severity === "warning" ? "high" : "normal"));
  const [houseId, setHouseId] = useState(task?.houseId ?? seedObservation?.houseId ?? defaultHouseId);
  const [floorId, setFloorId] = useState(task?.floorId ?? seedObservation?.floorId ?? "");
  const [areaId, setAreaId] = useState(task?.areaId ?? "");
  const [equipmentId, setEquipmentId] = useState(task?.equipmentId ?? "");
  const [plannedFor, setPlannedFor] = useState(task?.plannedFor ?? "");
  const [dueBy, setDueBy] = useState(task?.dueBy ?? "");
  const [observationIds, setObservationIds] = useState<string[]>(task?.observationIds ?? (seedObservation ? [seedObservation.id] : []));
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<"error" | "conflict" | "invalid-date" | "reload-error" | null>(null);

  useEffect(() => {
    setTitle(task?.title ?? seedObservation?.note ?? "");
    setDescription(task?.description ?? "");
    setBasis(task?.basis ?? (seedObservation ? "condition-based" : "scheduled"));
    setBasisDetail(task?.basisDetail ?? (seedObservation ? t("maintenance.basisFromObservation") : ""));
    setPriority(task?.priority ?? (seedObservation?.severity === "critical" ? "urgent" : seedObservation?.severity === "warning" ? "high" : "normal"));
    setHouseId(task?.houseId ?? seedObservation?.houseId ?? defaultHouseId);
    setFloorId(task?.floorId ?? seedObservation?.floorId ?? "");
    setAreaId(task?.areaId ?? "");
    setEquipmentId(task?.equipmentId ?? "");
    setPlannedFor(task?.plannedFor ?? "");
    setDueBy(task?.dueBy ?? "");
    setObservationIds(task?.observationIds ?? (seedObservation ? [seedObservation.id] : []));
    setFeedback(null);
  }, [defaultHouseId, propertyId, seedObservation?.id, task?.id, task?.revision, t]);

  const selectedHouse = houses.find((candidate) => candidate.id === houseId) ?? null;
  const linkableObservations = observations.filter((observation) => observation.houseId === houseId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !title.trim()) return;
    if (basis !== "predictive" && plannedFor && dueBy && plannedFor > dueBy) {
      setFeedback("invalid-date");
      return;
    }
    setPending(true);
    setFeedback(null);
    const common = {
      propertyId,
      houseId: houseId || null,
      floorId: floorId || null,
      areaId: areaId || null,
      equipmentId: equipmentId || null,
      title: title.trim(),
      description: description.trim() || null,
      basis,
      basisDetail: basisDetail.trim() || null,
      priority,
      plannedFor: plannedFor || null,
      dueBy: basis === "predictive" ? null : dueBy || null,
      observationIds,
    };
    try {
      const saved = task
        ? await onUpdate(task.id, { baseRevision: task.revision, ...common })
        : await onCreate(common);
      onSaved(saved);
    } catch (error) {
      setFeedback(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "error");
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    if (!task || pending) return;
    setPending(true);
    try {
      await onReload(task.id);
      setFeedback(null);
    } catch {
      setFeedback("reload-error");
    } finally {
      setPending(false);
    }
  };

  const toggleObservation = (id: string) => setObservationIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <section className="panel maintenance-editor" aria-labelledby={`${formId}-title`}>
    <header><div><span className="eyebrow">{t(task ? "maintenance.editEyebrow" : "maintenance.planEyebrow")}</span><h2 id={`${formId}-title`}>{t(task ? "maintenance.editTitle" : "maintenance.planTitle")}</h2><p>{t("maintenance.editorDescription")}</p></div><button type="button" className="icon-button" onClick={onCancel} aria-label={t("common.close")}><X size={18} /></button></header>
    <form onSubmit={(event) => void submit(event)} noValidate>
      <label className="field maintenance-title-field"><span>{t("maintenance.taskTitle")}</span><input autoFocus required value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder={t("maintenance.taskTitlePlaceholder")} /></label>
      <label className="field"><span>{t("maintenance.description")}</span><textarea rows={3} value={description} disabled={pending} onChange={(event) => setDescription(event.target.value)} placeholder={t("maintenance.descriptionPlaceholder")} /></label>
      <div className="maintenance-form-grid">
        <label className="field"><span>{t("maintenance.basis")}</span><select value={basis} disabled={pending} onChange={(event) => { const next = event.target.value as MaintenanceTaskBasis; setBasis(next); if (next === "predictive") setDueBy(""); }}>{bases.map((item) => <option key={item} value={item}>{t(`maintenance.basis.${item}` as TranslationKey)}</option>)}</select></label>
        <label className="field"><span>{t("maintenance.priority")}</span><select value={priority} disabled={pending} onChange={(event) => setPriority(event.target.value as MaintenanceTaskPriority)}>{priorities.map((item) => <option key={item} value={item}>{t(`maintenance.priority.${item}` as TranslationKey)}</option>)}</select></label>
        <label className="field"><span>{t("properties.houses")}</span><select value={houseId} disabled={pending} onChange={(event) => { setHouseId(event.target.value); setFloorId(""); setObservationIds([]); }}><option value="">{t("maintenance.wholeProperty")}</option>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
        {selectedHouse && <label className="field"><span>{t("common.floor")}</span><select value={floorId} disabled={pending} onChange={(event) => setFloorId(event.target.value)}><option value="">{selectedHouse.name}</option>{selectedHouse.floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select></label>}
        {areas.length > 0 && <label className="field"><span>{t("properties.areas")}</span><select value={areaId} disabled={pending} onChange={(event) => { setAreaId(event.target.value); setEquipmentId(""); if (event.target.value) setFloorId(""); }}><option value="">{t("maintenance.wholeProperty")}</option>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>}
        {areaId && <label className="field"><span>{t("properties.equipmentOptional")}</span><select value={equipmentId} disabled={pending} onChange={(event) => setEquipmentId(event.target.value)}><option value="">{t("properties.wholeArea")}</option>{equipment.filter((item) => item.areaId === areaId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <label className="field"><span>{t("maintenance.plannedFor")}</span><input type="date" value={plannedFor} disabled={pending} onChange={(event) => setPlannedFor(event.target.value)} /></label>
        <label className="field"><span>{t("maintenance.dueBy")}</span><input type="date" value={dueBy} disabled={pending || basis === "predictive"} onChange={(event) => setDueBy(event.target.value)} /><small>{t(basis === "predictive" ? "maintenance.predictiveNoDeadline" : "maintenance.dueByHelp")}</small></label>
        <label className="field maintenance-basis-detail"><span>{t("maintenance.basisDetail")}</span><input value={basisDetail} disabled={pending} onChange={(event) => setBasisDetail(event.target.value)} placeholder={t("maintenance.basisDetailPlaceholder")} /></label>
      </div>
      {linkableObservations.length > 0 && <fieldset className="maintenance-observation-links"><legend>{t("maintenance.linkedObservations")}</legend><p>{t("maintenance.linkedObservationsHelp")}</p><div>{linkableObservations.map((observation) => <label key={observation.id}><input type="checkbox" checked={observationIds.includes(observation.id)} disabled={pending} onChange={() => toggleObservation(observation.id)} /><span><strong>{observation.note}</strong><small>{t(`observations.${observation.kind === "note" ? "noteKind" : observation.kind}` as TranslationKey)}</small></span></label>)}</div></fieldset>}
      {feedback === "invalid-date" && <p className="inline-error" role="alert">{t("maintenance.invalidDates")}</p>}
      {feedback === "error" && <p className="inline-error" role="alert">{t("maintenance.saveFailed")}</p>}
      {(feedback === "conflict" || feedback === "reload-error") && <div className="maintenance-conflict"><p className="inline-error" role="alert">{t(feedback === "conflict" ? "maintenance.conflict" : "maintenance.reloadFailed")}</p>{task && <button type="button" className="text-button" disabled={pending} onClick={() => void reload()}>{t(pending ? "maintenance.reloading" : "maintenance.reload")}</button>}</div>}
      <div className="maintenance-editor-actions"><button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={pending || !title.trim()}>{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{t(pending ? "common.saving" : task ? "maintenance.saveChanges" : "maintenance.planWork")}</button></div>
    </form>
  </section>;
}

function TaskLifecycle({ task, onUpdate, onReload }: Readonly<{ task: MaintenanceTask; onUpdate: MaintenancePageProps["onUpdateTask"]; onReload: MaintenancePageProps["onReloadTask"] }>) {
  const { t } = useI18n();
  const statusRef = useRef<HTMLElement>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<"error" | "conflict" | "reload-error" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const transition = async (patch: Omit<MaintenanceTaskPatch, "baseRevision">) => {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const updated = await onUpdate(task.id, { baseRevision: task.revision, ...patch });
      setNote("");
      setAnnouncement("");
      window.setTimeout(() => {
        setAnnouncement(t("maintenance.statusChanged", { status: t(`maintenance.status.${updated.status}` as TranslationKey) }));
        statusRef.current?.focus();
      }, 0);
    } catch (error) {
      setFeedback(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "error");
    } finally {
      setPending(false);
    }
  };
  const reload = async () => {
    setPending(true);
    try { await onReload(task.id); setFeedback(null); } catch { setFeedback("reload-error"); } finally { setPending(false); }
  };
  return <section ref={statusRef} tabIndex={-1} className="maintenance-lifecycle" aria-label={t("maintenance.workStatus") }>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {task.status === "planned" && <button type="button" className="primary-button" disabled={pending} aria-busy={pending} onClick={() => void transition({ status: "in-progress" })}>{pending ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{pending ? t("auth.working") : t("maintenance.startWork")}</button>}
    {task.status === "in-progress" && <form onSubmit={(event) => { event.preventDefault(); if (note.trim()) void transition({ status: "completed", completionNote: note.trim() }); }}><label className="field"><span>{t("maintenance.completionOutcome")}</span><textarea required rows={2} value={note} disabled={pending} onChange={(event) => setNote(event.target.value)} placeholder={t("maintenance.completionPlaceholder")} /></label><button type="submit" className="primary-button" disabled={pending || !note.trim()} aria-busy={pending}>{pending ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}{pending ? t("auth.working") : t("maintenance.markCompleted")}</button></form>}
    {task.status === "completed" && <form onSubmit={(event) => { event.preventDefault(); if (note.trim()) void transition({ status: "verified", verificationNote: note.trim() }); }}><p className="maintenance-completion-evidence"><CheckCircle2 size={15} aria-hidden="true" /><span><strong>{t("maintenance.workCompleted")}</strong>{task.completionNote && <small>{task.completionNote}</small>}</span></p><label className="field"><span>{t("maintenance.verificationOutcome")}</span><textarea required rows={2} value={note} disabled={pending} onChange={(event) => setNote(event.target.value)} placeholder={t("maintenance.verificationPlaceholder")} /></label><button type="submit" className="primary-button" disabled={pending || !note.trim()} aria-busy={pending}>{pending ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}{pending ? t("auth.working") : t("maintenance.verifyWork")}</button></form>}
    {task.status === "cancelled" && <button type="button" className="secondary-button" disabled={pending} onClick={() => void transition({ status: "planned" })}><RotateCcw size={14} aria-hidden="true" />{t("maintenance.restoreTask")}</button>}
    {task.status === "verified" && <button type="button" className="secondary-button" disabled={pending} onClick={() => void transition({ status: "completed" })}><RotateCcw size={14} aria-hidden="true" />{t("maintenance.reopenWork")}</button>}
    {(task.status === "planned" || task.status === "in-progress") && <button type="button" className="text-button danger-text" disabled={pending} onClick={() => void transition({ status: "cancelled" })}>{t("maintenance.cancelTask")}</button>}
    {feedback === "error" && <p className="inline-error" role="alert">{t("maintenance.transitionFailed")}</p>}
    {(feedback === "conflict" || feedback === "reload-error") && <div className="maintenance-conflict"><p className="inline-error" role="alert">{t(feedback === "conflict" ? "maintenance.conflict" : "maintenance.reloadFailed")}</p><button type="button" className="text-button" disabled={pending} onClick={() => void reload()}>{t(pending ? "maintenance.reloading" : "maintenance.reload")}</button></div>}
  </section>;
}

function TaskRevisionHistory({ task, timeZone, onLoad }: Readonly<{ task: MaintenanceTask; timeZone: string; onLoad: MaintenancePageProps["onLoadTaskRevisions"] }>) {
  const { locale, t } = useI18n();
  const [revisions, setRevisions] = useState<MaintenanceTaskRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setRevisions(null); setFailed(false); }, [task.id, task.revision]);
  const load = async () => {
    setLoading(true); setFailed(false);
    try { setRevisions(await onLoad(task.id)); } catch { setFailed(true); } finally { setLoading(false); }
  };
  return <section className="maintenance-revisions" aria-label={t("maintenance.revisionHistory") }><div><span>{t("maintenance.currentRevision", { revision: task.revision })}</span><button type="button" className="text-button" disabled={loading} onClick={() => void load()}>{t(loading ? "maintenance.loadingRevisions" : "maintenance.showRevisions")}</button></div>{failed && <p className="inline-error" role="alert">{t("maintenance.revisionsFailed")}</p>}{revisions && <ol>{revisions.slice().reverse().map((revision) => {
    const actor = revision.actorLabel?.trim() || t(`activity.revisionActor.${revision.actor}`);
    return <li key={revision.revision}><span><strong>{t("maintenance.revision", { revision: revision.revision })}</strong><time dateTime={revision.changedAt}>{formatInTimeZone(revision.changedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</time></span><small>{t("maintenance.changedBy", { actor })}</small><small>{t("maintenance.changedFields", { fields: revision.changedFields.map((field) => t(`maintenance.field.${field}` as TranslationKey)).join(", ") })}</small></li>;
  })}</ol>}</section>;
}

function TaskCard({ task, houses, fallbackTimeZone, observations, areas, equipment, readOnly, onEdit, onUpdate, onReload, onLoadRevisions }: Readonly<{
  task: MaintenanceTask;
  houses: House[];
  fallbackTimeZone: string;
  observations: ManualObservation[];
  areas: PropertyArea[];
  equipment: AreaEquipment[];
  readOnly: boolean;
  onEdit: () => void;
  onUpdate: MaintenancePageProps["onUpdateTask"];
  onReload: MaintenancePageProps["onReloadTask"];
  onLoadRevisions: MaintenancePageProps["onLoadTaskRevisions"];
}>) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const house = houses.find((candidate) => candidate.id === task.houseId) ?? null;
  const floor = house?.floors.find((candidate) => candidate.id === task.floorId);
  const area = areas.find((candidate) => candidate.id === task.areaId);
  const installedEquipment = equipment.find((candidate) => candidate.id === task.equipmentId);
  const target = installedEquipment?.name ?? area?.name ?? floor?.name ?? house?.name ?? t("maintenance.wholeProperty");
  const timeZone = house?.timezone ?? fallbackTimeZone;
  const linked = observations.filter((observation) => task.observationIds.includes(observation.id));
  return <article className={`maintenance-task-card ${task.priority} ${task.status}`}>
    <button type="button" className="maintenance-task-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={`maintenance-priority-dot ${task.priority}`} aria-hidden="true" />
      <span className="maintenance-task-copy"><span><strong>{task.title}</strong><span className={`maintenance-status-badge ${task.status}`}>{t(`maintenance.status.${task.status}` as TranslationKey)}</span></span><small>{t(`maintenance.priority.${task.priority}` as TranslationKey)} | {t(`maintenance.basis.${task.basis}` as TranslationKey)} | <span>{target}</span></small>{taskDate(task) && <span><CalendarDays size={13} aria-hidden="true" />{task.dueBy ? t("maintenance.dueDate", { date: task.dueBy }) : t("maintenance.plannedDate", { date: task.plannedFor ?? "" })}</span>}</span>
      <ChevronDown size={17} aria-hidden="true" />
    </button>
    {open && <div className="maintenance-task-detail">
      {task.description && <p>{task.description}</p>}
      {task.basisDetail && <p className="maintenance-basis-explanation"><AlertTriangle size={14} aria-hidden="true" />{task.basisDetail}</p>}
      {linked.length > 0 && <div className="maintenance-linked-evidence"><strong>{t("maintenance.linkedObservations")}</strong><ul>{linked.map((observation) => <li key={observation.id}>{observation.note}</li>)}</ul></div>}
      {task.status === "verified" && <>
        <p className="maintenance-completion-evidence"><CheckCircle2 size={15} aria-hidden="true" /><span><strong>{t("maintenance.workCompleted")}</strong>{task.completionNote && <small>{task.completionNote}</small>}{task.completedAt && <time dateTime={task.completedAt}>{t("maintenance.field.completedAt")}: {formatInTimeZone(task.completedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</time>}</span></p>
        <p className="maintenance-completion-evidence verified"><ShieldCheck size={15} aria-hidden="true" /><span><strong>{t("maintenance.workVerified")}</strong>{task.verificationNote && <small>{task.verificationNote}</small>}{task.verifiedAt && <time dateTime={task.verifiedAt}>{t("maintenance.field.verifiedAt")}: {formatInTimeZone(task.verifiedAt, locale, timeZone, { dateStyle: "medium", timeStyle: "short" })}</time>}</span></p>
      </>}
      {!readOnly && <div className="maintenance-task-actions"><button type="button" className="secondary-button" onClick={onEdit}><Edit3 size={14} aria-hidden="true" />{t("maintenance.editTask")}</button></div>}
      {!readOnly && <TaskLifecycle task={task} onUpdate={onUpdate} onReload={onReload} />}
      <TaskRevisionHistory task={task} timeZone={timeZone} onLoad={onLoadRevisions} />
    </div>}
  </article>;
}

export function MaintenancePage(props: Readonly<MaintenancePageProps>) {
  const { t } = useI18n();
  const propertyId = props.propertyId ?? props.house?.propertyId ?? props.state.properties[0]?.id ?? "";
  const property = props.state.properties.find((candidate) => candidate.id === propertyId) ?? null;
  const houses = (props.houses ?? props.state.houses).filter((candidate) => candidate.propertyId === propertyId);
  const fallbackTimeZone = props.house?.propertyId === propertyId
    ? props.house.timezone
    : houses[0]?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const defaultHouseId = props.house?.propertyId === propertyId ? props.house.id : "";
  const areas = props.areas ?? [];
  const equipment = props.equipment ?? [];
  const readOnly = props.readOnly ?? false;
  const today = localObservationDate(new Date(), fallbackTimeZone);
  const tasks = props.state.maintenanceTasks.filter((task) => task.propertyId === propertyId
    && (!props.house || task.houseId === null || task.houseId === props.house.id));
  const houseIds = new Set(houses.map((house) => house.id));
  const observations = props.state.observations.filter((observation) => houseIds.has(observation.houseId));
  const seedObservation = observations.find((observation) => observation.id === props.initialObservationId);
  const [editorOpen, setEditorOpen] = useState(Boolean(seedObservation));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("active");
  const [basisFilter, setBasisFilter] = useState<"all" | MaintenanceTaskBasis>("all");
  const [search, setSearch] = useState("");
  const headerActionRef = useRef<HTMLButtonElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setEditorOpen(false);
    setEditingId(null);
    setFilter("active");
    setBasisFilter("all");
    setSearch("");
    editorOpenerRef.current = null;
  }, [propertyId]);

  useEffect(() => {
    if (props.initialObservationId && seedObservation) {
      setEditingId(null);
      setEditorOpen(true);
    } else if (props.initialObservationId) {
      props.onSeedConsumed?.();
    }
  }, [props.initialObservationId, props.onSeedConsumed, seedObservation]);

  const active = tasks.filter((task) => task.status !== "verified" && task.status !== "cancelled");
  const history = tasks.filter((task) => task.status === "verified" || task.status === "cancelled")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const overdueCount = active.filter((task) => task.status !== "completed" && task.dueBy && task.dueBy < today).length;
  const upcomingCount = active.filter((task) => task.status !== "completed" && taskDate(task)
    && (task.dueBy ? task.dueBy >= today : Boolean(task.plannedFor && task.plannedFor >= today))).length;
  const inProgressCount = active.filter((task) => task.status === "in-progress").length;
  const completedCount = active.filter((task) => task.status === "completed").length;
  const visible = useMemo(() => active.filter((task) => filter === "active"
      || (filter === "overdue" ? Boolean(task.status !== "completed" && task.dueBy && task.dueBy < today)
      : filter === "upcoming" ? Boolean(task.status !== "completed" && taskDate(task)
        && (task.dueBy ? task.dueBy >= today : task.plannedFor && task.plannedFor >= today))
      : task.status === filter))
    .filter((task) => basisFilter === "all" || task.basis === basisFilter)
    .filter((task) => `${task.title} ${task.description ?? ""} ${task.basisDetail ?? ""} ${houses.find((house) => house.id === task.houseId)?.name ?? ""} ${areas.find((area) => area.id === task.areaId)?.name ?? ""} ${equipment.find((item) => item.id === task.equipmentId)?.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [active, areas, basisFilter, equipment, filter, houses, search]);
  const verification = visible.filter((task) => task.status === "completed");
  const overdue = visible.filter((task) => task.status !== "completed" && Boolean(task.dueBy && task.dueBy < today)).sort((left, right) => (taskDate(left) ?? "").localeCompare(taskDate(right) ?? ""));
  const pastPlanned = visible.filter((task) => task.status !== "completed" && !task.dueBy
    && Boolean(task.plannedFor && task.plannedFor < today)).sort((left, right) => (taskDate(left) ?? "").localeCompare(taskDate(right) ?? ""));
  const upcoming = visible.filter((task) => task.status !== "completed" && taskDate(task)
    && !overdue.includes(task) && !pastPlanned.includes(task)).sort((left, right) => (taskDate(left) ?? "").localeCompare(taskDate(right) ?? ""));
  const priorityRank: Record<MaintenanceTaskPriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
  const unscheduled = visible.filter((task) => task.status !== "completed" && !taskDate(task)).sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority]);
  const editingTask = tasks.find((task) => task.id === editingId);

  const openEditor = (taskId: string | null = null) => {
    editorOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : headerActionRef.current;
    setEditingId(taskId);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
    props.onSeedConsumed?.();
    const opener = editorOpenerRef.current;
    editorOpenerRef.current = null;
    window.setTimeout(() => (opener?.isConnected ? opener : headerActionRef.current)?.focus(), 0);
  };
  const group = (title: string, items: MaintenanceTask[], icon: ReactNode) => items.length > 0 && <section className="maintenance-group"><header>{icon}<div><h3>{title}</h3><span>{items.length}</span></div></header><div>{items.map((task) => <TaskCard key={task.id} task={task} houses={houses} fallbackTimeZone={fallbackTimeZone} observations={observations} areas={areas} equipment={equipment} readOnly={readOnly} onEdit={() => openEditor(task.id)} onUpdate={props.onUpdateTask} onReload={props.onReloadTask} onLoadRevisions={props.onLoadTaskRevisions} />)}</div></section>;

  return <div className="page-stack operations-page maintenance-page">
    <header className="page-heading operations-heading"><div><span className="eyebrow"><Wrench size={14} aria-hidden="true" />{props.house?.name ?? property?.name ?? t("nav.properties")}</span><h1>{t("maintenance.pageTitle")}</h1><p>{t("maintenance.pageDescription")}</p></div>{!readOnly && <button ref={headerActionRef} type="button" className="primary-button" onClick={() => { if (editorOpen && !editingId) closeEditor(); else openEditor(); }}>{editorOpen && !editingId ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{t(editorOpen && !editingId ? "common.close" : "maintenance.planWork")}</button>}</header>
    <section className="operations-summary maintenance-summary" aria-label={t("maintenance.summary") }>
      <button type="button" aria-pressed={filter === "active"} className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}><span className="operations-summary-icon"><Wrench size={18} aria-hidden="true" /></span><span><small>{t("maintenance.allActive")}</small><strong>{active.length}</strong></span></button>
      <button type="button" aria-pressed={filter === "overdue"} className={filter === "overdue" ? "active attention" : overdueCount > 0 ? "attention" : ""} onClick={() => setFilter("overdue")}><span className="operations-summary-icon critical"><AlertTriangle size={18} aria-hidden="true" /></span><span><small>{t("maintenance.overdue")}</small><strong>{overdueCount}</strong></span></button>
      <button type="button" aria-pressed={filter === "upcoming"} className={filter === "upcoming" ? "active" : ""} onClick={() => setFilter("upcoming")}><span className="operations-summary-icon open"><CalendarDays size={18} aria-hidden="true" /></span><span><small>{t("maintenance.upcoming")}</small><strong>{upcomingCount}</strong></span></button>
      <button type="button" aria-pressed={filter === "in-progress"} className={filter === "in-progress" ? "active" : ""} onClick={() => setFilter("in-progress")}><span className="operations-summary-icon progress"><Clock3 size={18} aria-hidden="true" /></span><span><small>{t("maintenance.status.in-progress")}</small><strong>{inProgressCount}</strong></span></button>
      <button type="button" aria-pressed={filter === "completed"} className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}><span className="operations-summary-icon resolved"><ShieldCheck size={18} aria-hidden="true" /></span><span><small>{t("maintenance.awaitingVerification")}</small><strong>{completedCount}</strong></span></button>
    </section>

    {!readOnly && editorOpen && <TaskEditor key={`${propertyId}:${editingTask?.id ?? seedObservation?.id ?? "new"}`} propertyId={propertyId} houses={houses} defaultHouseId={defaultHouseId} observations={observations} areas={areas} equipment={equipment} {...(editingTask ? { task: editingTask } : {})} {...(!editingTask && seedObservation ? { seedObservation } : {})} onCreate={props.onCreateTask} onUpdate={props.onUpdateTask} onReload={props.onReloadTask} onSaved={closeEditor} onCancel={closeEditor} />}

    <section className="panel maintenance-workspace" aria-labelledby="maintenance-work-plan-title">
      <div className="maintenance-workspace-heading"><div><span className="eyebrow">{t("maintenance.workPlanEyebrow")}</span><h2 id="maintenance-work-plan-title">{t("maintenance.workPlan")}</h2></div><span>{t("maintenance.activeCount", { count: active.length })}</span></div>
      <div className="operations-toolbar"><label className="field operations-search-field"><span>{t("maintenance.search")}</span><span className="operations-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("maintenance.searchPlaceholder")} /></span></label><label className="field operations-filter"><span>{t("maintenance.basis")}</span><select value={basisFilter} onChange={(event) => setBasisFilter(event.target.value as typeof basisFilter)}><option value="all">{t("maintenance.allBases")}</option>{bases.map((basis) => <option key={basis} value={basis}>{t(`maintenance.basis.${basis}` as TranslationKey)}</option>)}</select></label></div>
      {visible.length === 0 ? <div className="operations-empty"><Wrench size={25} aria-hidden="true" /><strong>{t("maintenance.emptyTitle")}</strong><p>{t("maintenance.emptyDescription")}</p></div> : <div className="maintenance-groups">{group(t("maintenance.verificationNeeded"), verification, <ShieldCheck size={18} aria-hidden="true" />)}{group(t("maintenance.overdue"), overdue, <AlertTriangle size={18} aria-hidden="true" />)}{group(t("maintenance.pastPlanned"), pastPlanned, <Clock3 size={18} aria-hidden="true" />)}{group(t("maintenance.upcoming"), upcoming, <CalendarDays size={18} aria-hidden="true" />)}{group(t("maintenance.unscheduled"), unscheduled, <Clock3 size={18} aria-hidden="true" />)}</div>}
    </section>
    {history.length > 0 && <details className="panel maintenance-history"><summary><span><History size={17} aria-hidden="true" /><span><strong>{t("maintenance.history")}</strong><small>{t("maintenance.historyCount", { count: history.length })}</small></span></span><ChevronDown size={17} aria-hidden="true" /></summary><div>{history.map((task) => <TaskCard key={task.id} task={task} houses={houses} fallbackTimeZone={fallbackTimeZone} observations={observations} areas={areas} equipment={equipment} readOnly={readOnly} onEdit={() => openEditor(task.id)} onUpdate={props.onUpdateTask} onReload={props.onReloadTask} onLoadRevisions={props.onLoadTaskRevisions} />)}</div></details>}
  </div>;
}
