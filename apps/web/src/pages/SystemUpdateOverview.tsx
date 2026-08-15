import {
  AppWindow,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CloudDownload,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ApplicationSystemUpdateStatus,
  HostReadyToRestartBinding,
  HostSystemUpdateStatus,
  SystemUpdateBlockReason,
  SystemUpdateStatus,
  SystemUpdateWorkflow,
  SystemUpdateWorkflowPhase,
  SystemUpdateWorkflowStep,
  SystemUpdateWorkflowStepId,
  SystemUpdateWorkflowStepState,
} from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import { RestartInstallDialog } from "./RestartInstallDialog";

export type SystemUpdateStreamState = "connecting" | "live" | "reconnecting" | "polling";

const terminalWorkflowPhases = new Set<SystemUpdateWorkflowPhase>([
  "complete", "cancelled", "failed", "application-failed", "returned", "host-returned", "recovery-needed",
]);

const workflowSteps: ReadonlyArray<{ id: SystemUpdateWorkflowStepId; label: TranslationKey; help: TranslationKey }> = [
  { id: "backup", label: "updates.workflow.step.backup", help: "updates.workflow.step.backupHelp" },
  { id: "stage-host", label: "updates.workflow.step.stageHost", help: "updates.workflow.step.stageHostHelp" },
  { id: "restart-host", label: "updates.workflow.step.restartHost", help: "updates.workflow.step.restartHostHelp" },
  { id: "verify-host", label: "updates.workflow.step.verifyHost", help: "updates.workflow.step.verifyHostHelp" },
  { id: "update-application", label: "updates.workflow.step.updateApplication", help: "updates.workflow.step.updateApplicationHelp" },
  { id: "verify-application", label: "updates.workflow.step.verifyApplication", help: "updates.workflow.step.verifyApplicationHelp" },
];

const reasonKeys = {
  "agent-offline": "updates.block.agentOffline",
  "agent-not-connected": "updates.block.agentOffline",
  "agent-upgrade-required": "updates.block.agentUpgrade",
  "host-updater-offline": "updates.block.hostUpdaterOffline",
  "host-updater-upgrade-required": "updates.block.hostUpdaterUpgrade",
  "platform-managed-externally": "updates.block.managedExternally",
  "factory-transition-required": "updates.block.factoryTransition",
  "appliance-upgrade-required": "updates.block.factoryTransition",
  "cli-transition-required": "updates.block.cliTransition",
  "hardware-unqualified": "updates.block.hardwareUnqualified",
  "mutation-busy": "updates.block.mutationBusy",
  "recovery-required": "updates.block.recoveryRequired",
  "backup-unavailable": "updates.block.backupUnavailable",
  "off-device-backup-required": "updates.block.offDeviceBackup",
  "metadata-unavailable": "updates.block.metadataUnavailable",
  "trust-verification-failed": "updates.block.trustFailed",
  "verification-failed": "updates.block.verificationFailed",
  "status-stale": "updates.block.statusStale",
  "not-configured": "updates.block.notConfigured",
} as const satisfies Record<SystemUpdateBlockReason, TranslationKey>;

function reasonKey(reason: string | null | undefined): TranslationKey {
  return reason && Object.prototype.hasOwnProperty.call(reasonKeys, reason)
    ? reasonKeys[reason as keyof typeof reasonKeys]
    : "updates.block.unknown";
}

function hostReasonKey(reason: string | null | undefined): TranslationKey {
  if (["agent-offline", "agent-not-connected", "bridge-not-connected", "HOST_UPDATER_OFFLINE"].includes(reason ?? "")) {
    return "updates.block.hostUpdaterOffline";
  }
  if (reason === "not-raspberry-pi") return "updates.block.managedExternally";
  return reasonKey(reason);
}

function applicationReasonKey(reason: SystemUpdateStatus["capability"]["reason"]): TranslationKey {
  if (reason === "appliance-upgrade-required") return "updates.block.factoryTransition";
  if (reason === "agent-upgrade-required") return "updates.block.agentUpgrade";
  if (reason === "agent-not-ready") return "updates.block.agentNotReady";
  if (reason === "system-update-recovery-needed") return "updates.block.recoveryRequired";
  if (reason === "system-update-workflow-active" || reason === "host-update-active") return "updates.block.mutationBusy";
  if (reason === "not-configured") return "updates.block.notConfigured";
  return "updates.block.agentOffline";
}

function applicationStatus(status: SystemUpdateStatus): ApplicationSystemUpdateStatus {
  return status.application ?? {
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    updateAvailable: status.updateAvailable,
    capability: status.capability,
    operation: status.operation,
  };
}

function hostStatus(status: SystemUpdateStatus): HostSystemUpdateStatus {
  if (status.host) return status.host;
  if (status.capability.runtime === "raspberry-pi") {
    const factory = status.capability.reason === "appliance-upgrade-required";
    return {
      supported: false,
      phase: "idle",
      reason: factory ? "factory-transition-required" : "cli-transition-required",
      updateAvailable: false,
      currentVersion: null,
      currentGeneration: null,
      readyToRestart: null,
    };
  }
  return {
    supported: false,
    phase: "idle",
    reason: "platform-managed-externally",
    updateAvailable: false,
    currentVersion: null,
    currentGeneration: null,
    readyToRestart: null,
  };
}

export function systemUpdateIsActive(status: SystemUpdateStatus | null): boolean {
  if (!status) return false;
  if (status.workflow && !terminalWorkflowPhases.has(status.workflow.phase)) return true;
  return Boolean(status.operation && [
    "queued", "preparing", "backup", "pulling", "applying", "verifying", "rolling-back",
  ].includes(status.operation.phase));
}

function workflowPhaseKey(phase: SystemUpdateWorkflowPhase): TranslationKey {
  const keys: Record<SystemUpdateWorkflowPhase, TranslationKey> = {
    preparing: "updates.workflow.phase.preparing",
    "backup-active": "updates.workflow.phase.backingUp",
    "backup-complete": "updates.workflow.phase.backupComplete",
    "host-stage-queueing": "updates.workflow.phase.hostStageQueueing",
    "host-stage-requested": "updates.workflow.phase.hostStageQueueing",
    "host-staging": "updates.workflow.phase.stagingHost",
    "awaiting-restart": "updates.workflow.phase.awaitingRestart",
    restarting: "updates.workflow.phase.activatingHost",
    "host-verifying": "updates.workflow.phase.verifyingHost",
    "host-complete": "updates.workflow.phase.hostComplete",
    "application-queueing": "updates.workflow.phase.applicationQueueing",
    "application-queued": "updates.workflow.phase.applicationQueued",
    "application-updating": "updates.workflow.phase.updatingApplication",
    "application-failed": "updates.workflow.phase.applicationFailed",
    complete: "updates.workflow.phase.complete",
    cancelled: "updates.workflow.phase.cancelled",
    failed: "updates.workflow.phase.failed",
    returned: "updates.workflow.phase.hostReturned",
    "recovery-needed": "updates.workflow.phase.recoveryNeeded",
    queued: "updates.workflow.phase.queued",
    "backing-up": "updates.workflow.phase.backingUp",
    "staging-host": "updates.workflow.phase.stagingHost",
    "activating-host": "updates.workflow.phase.activatingHost",
    "verifying-host": "updates.workflow.phase.verifyingHost",
    "updating-application": "updates.workflow.phase.updatingApplication",
    "verifying-application": "updates.workflow.phase.verifyingApplication",
    "rolling-back-application": "updates.workflow.phase.rollingBackApplication",
    "host-returned": "updates.workflow.phase.hostReturned",
  };
  return (keys as Readonly<Record<string, TranslationKey>>)[phase] ?? "updates.workflow.phase.failed";
}

function derivedStepState(phase: SystemUpdateWorkflowPhase, id: SystemUpdateWorkflowStepId): SystemUpdateWorkflowStepState {
  const order = workflowSteps.map((step) => step.id);
  if (phase === "complete") return "complete";
  if (phase === "cancelled") return id === "backup" ? "complete" : "skipped";
  if (phase === "returned" || phase === "host-returned") {
    if (["backup", "stage-host", "restart-host"].includes(id)) return "complete";
    if (id === "verify-host") return "rolled-back";
    return "skipped";
  }
  const activeId: Partial<Record<SystemUpdateWorkflowPhase, SystemUpdateWorkflowStepId>> = {
    preparing: "backup",
    "backup-active": "backup",
    "backup-complete": "stage-host",
    "host-stage-queueing": "stage-host",
    "host-stage-requested": "stage-host",
    "host-staging": "stage-host",
    restarting: "restart-host",
    "host-verifying": "verify-host",
    "host-complete": "update-application",
    "application-queueing": "update-application",
    "application-queued": "update-application",
    "application-updating": "update-application",
    "application-failed": "update-application",
    queued: "backup",
    "backing-up": "backup",
    "staging-host": "stage-host",
    "awaiting-restart": "restart-host",
    "activating-host": "restart-host",
    "verifying-host": "verify-host",
    "updating-application": "update-application",
    "verifying-application": "verify-application",
    "rolling-back-application": "update-application",
  };
  const active = activeId[phase];
  if (!active) return phase === "recovery-needed" || phase === "failed" ? "failed" : "pending";
  const activeIndex = order.indexOf(active);
  const index = order.indexOf(id);
  if (index < activeIndex) return "complete";
  if (index > activeIndex) return "pending";
  if (phase === "awaiting-restart") return "waiting";
  if (phase === "application-failed") return "failed";
  if (phase === "rolling-back-application") return "rolled-back";
  return "active";
}

function WorkflowProgress({ workflow, streamState }: { workflow: SystemUpdateWorkflow; streamState: SystemUpdateStreamState }) {
  const { t } = useI18n();
  const states = new Map((workflow.steps ?? []).map((step) => [step.id, step]));
  const active = !terminalWorkflowPhases.has(workflow.phase);
  const disconnected = active && streamState === "reconnecting";
  return <section className={`unified-update-workflow ${workflow.phase}`} aria-labelledby="unified-update-workflow-title">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {t(workflowPhaseKey(workflow.phase))}{disconnected ? ` ${t("updates.connection.reconnecting")}` : ""}
    </p>
    <div className="unified-update-workflow__heading">
      <span aria-hidden="true">
        {workflow.phase === "complete" ? <CheckCircle2 size={20} />
          : workflow.phase === "recovery-needed" || workflow.phase === "failed" || workflow.phase === "application-failed" || workflow.phase === "returned" || workflow.phase === "host-returned" ? <CircleAlert size={20} />
            : <LoaderCircle className={active && !disconnected ? "spin" : ""} size={20} />}
      </span>
      <div>
        <div className="unified-update-workflow__kicker">
          <span className="eyebrow">{t("updates.workflow.title")}</span>
          {active && <span className={`updates-stream-state ${streamState}`}><span aria-hidden="true" />{t(disconnected ? "updates.connection.reconnecting" : `updates.stream.${streamState}` as TranslationKey)}</span>}
        </div>
        <h3 id="unified-update-workflow-title">{t(workflowPhaseKey(workflow.phase))}</h3>
        {workflow.detail && <small>{workflow.detail}</small>}
      </div>
    </div>
    <ol className="unified-update-workflow__steps">
      {workflowSteps.map((step) => {
        const supplied = states.get(step.id) as SystemUpdateWorkflowStep | undefined;
        const state = supplied?.state ?? derivedStepState(workflow.phase, step.id);
        return <li key={step.id} className={state} aria-current={state === "active" || state === "waiting" ? "step" : undefined}>
          <span className="unified-update-workflow__marker" aria-hidden="true">
            {state === "complete" ? <CheckCircle2 size={16} />
              : state === "active" ? <LoaderCircle className="spin" size={16} />
                : state === "waiting" ? <RotateCw size={16} />
                  : state === "failed" || state === "rolled-back" ? <CircleAlert size={16} />
                    : <span />}
          </span>
          <span><strong>{t(step.label)}</strong><small>{supplied?.detail || t(step.help)}</small></span>
        </li>;
      })}
    </ol>
  </section>;
}

function StateBadge({ label, tone }: { label: string; tone: "ready" | "available" | "attention" | "muted" }) {
  return <span className={`unified-update-state ${tone}`}>
    <span aria-hidden="true" />{label}
  </span>;
}

function version(value: string | null | undefined): string {
  return value ? `v${value.replace(/^v/u, "")}` : "\u2014";
}

function formattedDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

interface SystemUpdateOverviewProps {
  status: SystemUpdateStatus;
  busy: string | null;
  streamState: SystemUpdateStreamState;
  onCheck: () => void;
  onUpdateEverything: () => void;
  onActivateHost: (binding: HostReadyToRestartBinding) => void;
  onCancelHost: (binding: HostReadyToRestartBinding) => void;
  onRetryApplication: () => void;
}

export function SystemUpdateOverview({
  status,
  busy,
  streamState,
  onCheck,
  onUpdateEverything,
  onActivateHost,
  onCancelHost,
  onRetryApplication,
}: SystemUpdateOverviewProps) {
  const { t, locale } = useI18n();
  const app = applicationStatus(status);
  const host = hostStatus(status);
  const workflow = status.workflow ?? null;
  const binding = host.readyToRestart ?? null;
  const lastChecked = formattedDate(status.lastCheckedAt, locale);
  const recovery = workflow?.recoveryRequired === true
    || workflow?.phase === "recovery-needed"
    || workflow?.reason === "recovery-required"
    || host.phase === "recovery-needed"
    || host.reason === "recovery-required";
  const awaitingRestart = Boolean(binding
    && workflow?.phase === "awaiting-restart"
    && status.revision !== undefined
    && workflow.revision === status.revision
    && workflow.hostOperationId === binding.operationId
    && workflow.targets.hostVersion === binding.targetVersion
    && workflow.targets.hostGeneration === binding.targetGeneration
    && workflow.targets.hostDigest === binding.targetDigest);
  const unboundPreparedHost = Boolean(binding && !awaitingRestart);
  const active = systemUpdateIsActive(status);
  const available = app.updateAvailable || host.updateAvailable;
  const appMetadataMissing = app.updateAvailable && !app.latestVersion;
  const hostMetadataMissing = host.updateAvailable && (!host.targetVersion
    || host.targetGeneration === null
    || host.targetGeneration === undefined
    || !host.targetDigest);
  const projectionBlocked = appMetadataMissing || hostMetadataMissing;
  const expectedWorkflowInterlock = Boolean(workflow
    && !terminalWorkflowPhases.has(workflow.phase)
    && status.revision !== undefined
    && workflow.revision === status.revision
    && ["system-update-workflow-active", "host-update-active"].includes(app.capability.reason));
  const expectedApplicationRetryInterlock = Boolean(workflow
    && workflow.phase === "application-failed"
    && status.revision !== undefined
    && workflow.revision === status.revision
    && Boolean(workflow.targets.applicationVersion)
    && host.phase === "complete"
    && app.capability.reason === "system-update-workflow-active");
  const applicationCapabilityBlocks = !expectedWorkflowInterlock
    && !expectedApplicationRetryInterlock
    && (!app.capability.available || app.capability.reason !== "ready");
  const appBlockedReason = !applicationCapabilityBlocks
    ? null
    : app.capability.reason === "ready" ? "agent-not-ready" : app.capability.reason;
  const hostManagedExternally = ["platform-managed-externally", "not-raspberry-pi"].includes(host.reason ?? "");
  const hostReasonBlocks = !hostManagedExternally
    && Boolean(host.reason || !host.supported || host.phase === "unavailable");
  const overallBlocked = projectionBlocked || applicationCapabilityBlocks || hostReasonBlocks || unboundPreparedHost;
  const workflowAllowsNewUpdate = !workflow || [
    "complete", "cancelled", "failed", "returned", "host-returned",
  ].includes(workflow.phase);
  const canUpdate = available
    && !active
    && !recovery
    && !awaitingRestart
    && !unboundPreparedHost
    && !overallBlocked
    && workflowAllowsNewUpdate
    && (!app.updateAvailable || app.capability.available)
    && (!host.updateAvailable || (host.supported && !hostReasonBlocks));
  const canRetry = workflow?.phase === "application-failed"
    && Boolean(workflow.targets.applicationVersion)
    && host.phase === "complete"
    && (app.capability.available || expectedApplicationRetryInterlock)
    && !overallBlocked
    && !recovery;
  const canRestart = awaitingRestart && Boolean(binding) && !overallBlocked && !recovery;
  const [restartBinding, setRestartBinding] = useState<HostReadyToRestartBinding | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const restartBindingIsCurrent = Boolean(restartBinding
    && binding
    && canRestart
    && restartBinding.operationId === binding.operationId
    && restartBinding.targetVersion === binding.targetVersion
    && restartBinding.targetGeneration === binding.targetGeneration
    && restartBinding.targetDigest === binding.targetDigest);

  useEffect(() => {
    if (restartBinding && !restartBindingIsCurrent) setRestartBinding(null);
  }, [restartBinding, restartBindingIsCurrent]);

  const hostReturned = workflow?.phase === "returned" || workflow?.phase === "host-returned" || host.phase === "returned";
  const applicationFailed = workflow?.phase === "application-failed";
  const workflowFailed = workflow?.phase === "failed";
  const applicationWorkflowActive = Boolean(workflow && [
    "application-queueing", "application-queued", "application-updating",
    "updating-application", "verifying-application", "rolling-back-application",
  ].includes(workflow.phase));
  const hostWorkflowActive = Boolean(workflow && [
    "host-stage-requested", "host-stage-queueing", "host-staging", "restarting", "host-verifying",
    "staging-host", "activating-host", "verifying-host",
  ].includes(workflow.phase));
  const showApplicationRelease = Boolean(app.latestVersion
    && (app.updateAvailable || app.latestVersion !== app.currentVersion));
  const applicationReleaseLabel = app.updateAvailable
    ? t("updates.component.available")
    : t(status.latestRelease?.prerelease
      ? "updates.component.latestPreview"
      : "updates.component.latestStable");
  const showHostTarget = Boolean(host.targetVersion && (
    host.updateAvailable
    || awaitingRestart
    || hostWorkflowActive
    || host.targetGeneration !== host.currentGeneration
  ));
  const overallTone = recovery || overallBlocked || workflowFailed || applicationFailed || hostReturned
    ? "attention"
    : available || awaitingRestart || active
      ? "available"
      : "ready";
  const headline = recovery
    ? t("updates.overall.recoveryNeeded")
    : workflowFailed
      ? t("updates.overall.failed")
      : hostReturned
        ? t("updates.overall.hostReturned")
        : overallBlocked
          ? t("updates.overall.blocked")
          : applicationFailed
            ? t("updates.overall.applicationFailed")
            : awaitingRestart
              ? t("updates.overall.awaitingRestart")
              : active
                ? t("updates.overall.inProgress")
                : available
                  ? t(hostManagedExternally && app.updateAvailable && !host.updateAvailable
                    ? "updates.overall.applicationAvailable"
                    : "updates.overall.available")
                  : t("updates.overall.current");
  const summary = recovery
    ? t("updates.overall.recoveryNeededHelp")
    : workflowFailed
      ? t("updates.overall.failedHelp")
      : hostReturned
        ? t("updates.overall.failedHelp")
        : overallBlocked
          ? t(projectionBlocked ? "updates.overall.blockedHelp" : "updates.overall.blockedSafetyHelp")
          : applicationFailed
            ? t("updates.overall.applicationFailedHelp")
            : awaitingRestart
              ? t("updates.overall.awaitingRestartHelp")
              : active
                ? t("updates.overall.inProgressHelp")
                : available
                  ? t(hostManagedExternally && app.updateAvailable && !host.updateAvailable
                    ? "updates.overall.applicationAvailableHelp"
                    : "updates.overall.availableHelp")
                  : t("updates.overall.currentHelp");
  const appState = applicationFailed || appMetadataMissing || applicationCapabilityBlocks
    ? t("updates.component.blocked")
    : applicationWorkflowActive || app.operation && ["queued", "preparing", "backup", "pulling", "applying", "verifying", "rolling-back"].includes(app.operation.phase)
      ? t("updates.component.inProgress")
      : app.updateAvailable
        ? t("updates.component.ready")
        : t("updates.component.current");
  const hostState = hostMetadataMissing || unboundPreparedHost || hostReasonBlocks
    ? t("updates.component.blocked")
    : awaitingRestart
      ? t("updates.component.readyToRestart")
      : hostWorkflowActive || host.phase === "restarting" || host.phase === "verifying"
          ? t("updates.component.inProgress")
          : host.updateAvailable
            ? t("updates.component.ready")
            : hostManagedExternally
              ? t("updates.component.managedSeparately")
              : host.reason
                ? t("updates.component.blocked")
                : t("updates.component.current");
  const updateActionLabel = app.updateAvailable && host.updateAvailable
    ? t("updates.action.updateEverything")
    : app.updateAvailable
      ? t("updates.action.updateApplication")
      : t("updates.action.updateHost");

  const openRecovery = () => {
    setDetailsOpen(true);
    window.setTimeout(() => detailsRef.current?.querySelector("summary")?.focus(), 0);
  };

  return <section className={`panel unified-update-card ${overallTone}`} aria-labelledby="unified-update-title">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label={t("updates.a11y.status")}>
      {headline}. {summary} {t("updates.component.application")}: {appState}. {t("updates.component.host")}: {hostState}.
    </p>
    <div className="unified-update-card__header">
      <span className="unified-update-card__icon" aria-hidden="true">
        {overallTone === "attention" ? <ShieldAlert size={22} /> : available || active ? <CloudDownload size={22} /> : <ShieldCheck size={22} />}
      </span>
      <div>
        <span className="eyebrow">{t("updates.eyebrow")}</span>
        <h2 id="unified-update-title">{headline}</h2>
        <p>{summary}</p>
      </div>
      <button type="button" className="secondary-button unified-update-check" disabled={busy !== null || active} onClick={onCheck}>
        <RefreshCw className={busy === "check" ? "spin" : ""} size={15} aria-hidden="true" />
        {t("updates.checkNow")}
      </button>
    </div>

    {status.checkError && <p className="unified-update-check-error" role="status"><CircleAlert size={14} aria-hidden="true" />{status.checkError}</p>}

    <div className="unified-update-components" role="list" aria-label={t("updates.components") }>
      <article className="unified-update-component" role="listitem">
        <span className="unified-update-component__icon" aria-hidden="true"><AppWindow size={20} /></span>
        <div className="unified-update-component__body">
          <div className="unified-update-component__heading"><h3>{t("updates.component.application")}</h3><StateBadge label={appState} tone={appBlockedReason || appMetadataMissing || applicationFailed ? "attention" : app.updateAvailable ? "available" : "ready"} /></div>
          <dl>
            <div><dt>{t("updates.component.installed")}</dt><dd>{version(app.currentVersion)}</dd></div>
            {showApplicationRelease && <div><dt>{applicationReleaseLabel}</dt><dd>{version(app.latestVersion)}</dd></div>}
          </dl>
          {appMetadataMissing
            ? <p className="unified-update-reason"><CircleAlert size={14} aria-hidden="true" />{t("updates.block.metadataUnavailable")}</p>
            : appBlockedReason && <p className="unified-update-reason"><CircleAlert size={14} aria-hidden="true" />{t(applicationReasonKey(appBlockedReason))}</p>}
        </div>
      </article>

      <article className="unified-update-component" role="listitem">
        <span className="unified-update-component__icon" aria-hidden="true"><Server size={20} /></span>
        <div className="unified-update-component__body">
          <div className="unified-update-component__heading"><h3>{t("updates.component.host")}</h3><StateBadge label={hostState} tone={hostMetadataMissing || unboundPreparedHost || hostReasonBlocks ? "attention" : host.updateAvailable || awaitingRestart ? "available" : host.supported ? "ready" : "muted"} /></div>
          <dl>
            <div><dt>{t("updates.component.installed")}</dt><dd>{host.currentVersion ? version(host.currentVersion) : host.currentGeneration !== null && host.currentGeneration !== undefined ? t("updates.component.generation", { generation: host.currentGeneration }) : "\u2014"}</dd></div>
            {showHostTarget && <div><dt>{t(host.updateAvailable ? "updates.component.available" : "updates.component.target")}</dt><dd>{`${version(host.targetVersion)} \u00b7 ${t("updates.component.generation", { generation: host.targetGeneration ?? "\u2014" })}`}</dd></div>}
          </dl>
          {hostMetadataMissing
            ? <p className="unified-update-reason"><CircleAlert size={14} aria-hidden="true" />{t("updates.block.metadataUnavailable")}</p>
            : unboundPreparedHost
            ? <p className="unified-update-reason"><CircleAlert size={14} aria-hidden="true" />{t("updates.block.unboundPrepared")}</p>
            : (host.reason || hostReasonBlocks) && <p className={`unified-update-reason ${hostManagedExternally ? "muted" : ""}`}><CircleAlert size={14} aria-hidden="true" />{t(host.reason ? hostReasonKey(host.reason) : "updates.block.unknown")}</p>}
        </div>
      </article>
    </div>

    {workflow && <WorkflowProgress workflow={workflow} streamState={streamState} />}

    <div className="unified-update-actions">
      {recovery ? <button type="button" className="primary-button" onClick={openRecovery}><ShieldAlert size={16} aria-hidden="true" />{t("updates.action.viewRecovery")}</button>
        : canRestart && binding ? <button type="button" className="primary-button" disabled={busy !== null} onClick={() => setRestartBinding(binding)}><RotateCw size={16} aria-hidden="true" />{t("updates.action.restartAndInstall")}</button>
          : canUpdate ? <button type="button" className="primary-button" disabled={busy !== null} onClick={onUpdateEverything}><CloudDownload size={16} aria-hidden="true" />{busy === "update-everything" || busy === "install" ? t("updates.requesting") : updateActionLabel}</button>
            : canRetry ? <button type="button" className="primary-button" disabled={busy !== null} onClick={onRetryApplication}><RefreshCw size={16} aria-hidden="true" />{t("updates.action.retryApplication")}</button>
              : null}
      {canRestart && binding && (workflow?.canCancel ?? true) && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => onCancelHost(binding)}>{t("updates.action.cancelPrepared")}</button>}
      {lastChecked && <small>{t("updates.lastChecked", { date: lastChecked })}</small>}
    </div>

    {(host.reason || workflow?.reason || host.detail || unboundPreparedHost) && <details ref={detailsRef} className="unified-update-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
      <summary><ChevronDown size={16} aria-hidden="true" /><span><strong>{recovery ? t("updates.recovery.title") : t("updates.advanced.title")}</strong><small>{recovery ? t("updates.recovery.summary") : t("updates.advanced.summary")}</small></span></summary>
      <div className="unified-update-details__content">
        {(workflow?.reason || host.reason) && <p>{t(
          workflow?.reason ? reasonKey(workflow.reason) : hostReasonKey(host.reason),
        )}</p>}
        {unboundPreparedHost && <p>{t("updates.block.unboundPrepared")}</p>}
        {host.detail && <p>{host.detail}</p>}
        {(host.reason === "factory-transition-required" || host.reason === "appliance-upgrade-required") && <div className="unified-update-transition"><strong>{t("updates.transition.factoryTitle")}</strong><p>{t("updates.transition.factoryBody")}</p></div>}
        {host.reason === "cli-transition-required" && <div className="unified-update-transition"><strong>{t("updates.transition.cliTitle")}</strong><p>{t("updates.transition.cliBody")}</p><pre><code>{t("updates.transition.cliCommands")}</code></pre></div>}
      </div>
    </details>}

    <RestartInstallDialog
      open={restartBindingIsCurrent}
      binding={restartBinding}
      busy={busy === "activate-host"}
      onCancel={() => setRestartBinding(null)}
      onConfirm={() => {
        if (!restartBinding || !canRestart) return;
        setRestartBinding(null);
        onActivateHost(restartBinding);
      }}
    />
  </section>;
}
