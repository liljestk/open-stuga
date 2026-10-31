import {
  Building2,
  Check,
  ChevronRight,
  CircleDot,
  CloudSun,
  ExternalLink,
  Home,
  Hourglass,
  LocateFixed,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Pencil,
  RadioTower,
  RefreshCw,
  Router,
  ShieldCheck,
  ThermometerSun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { LocationDiscoveryPanel } from "../../components/LocationDiscoveryPanel";
import { locationForRoute } from "../../routing";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { countKey } from "../../i18n";
import { ConnectionSourceManager } from "./ConnectionSourceManager";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, decimal, setupSectionOrder } from "./setupModel";
import { useIntegrationsPagePart06 } from "./part-06";
import { CredentialControls } from "./CredentialControls";
import { GreeSetupPanel } from "./GreeSetupPanel";
import { TuyaSetupPanel } from "./TuyaSetupPanel";
import { Nexus433SetupPanel } from "./Nexus433SetupPanel";
import { SetupProviderGrid } from "./SetupProviderGrid";
import { Tabs } from "../../components/Tabs";
import { CardHeader } from "../../components/CardHeader";
export function renderIntegrationsPage(context: ReturnType<typeof useIntegrationsPagePart06>) {
  const { houses, connectionHouses, tpLinkDevicesError, canManageIntegrations, onIntegrationChange, onOpenSensors, onOpenLayout, locale, t, house, integration, activeSection, testing, result, testingDirect, directResult, discovering, discovery, discoveryOutcome, connectionSetupOpen, setConnectionSetupOpen, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, tpLinkUsername, tpLinkPassword, reuseSavedTpLinkAccount, setReuseSavedTpLinkAccount, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, tpLinkInventoryRefreshFailed, tpLinkExportEnabled, tpLinkExportJobs, tpLinkExportAutomation, tpLinkExportJobsLoading, tpLinkExportJobsError, busyTpLinkExportJobId, tpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, tpLinkChildDiscovery, haUrl, haToken, showHaToken, setShowHaToken, savingHomeAssistant, homeAssistantFeedback, busyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, savingLocation, locationFeedback, setLocationFeedback, localDateTime, homeAssistantAssignments, tpLinkAssignments, changeTpLinkDraft, changeHomeAssistantDraft, coordinateValidationVisible, timezoneValidationVisible, draftMapLocation, selectSetupHouse, disconnectHomeAssistantAssignment, disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob, scanIntegrations, settleTpLinkChildren, saveTpLink, saveHomeAssistant, saveLocation, removeLocation, usePlacementForWeather, savePlacementForWeather, applyDiscoveredDefaults, discoveredCount, sensorSourceConfigured, sensorSourceConnected, tpLinkReadyDevices, assignmentCount, connectedSourceLabel, tpLinkHealthState, tpLinkHealthLabel, tpLinkStatusTitle, connectionWorkspaceActive, steps, completeCount, nextStepIndex, nextStep, selectedDiscoveredTpLink, selectedDiscoveredHomeAssistant, primarySetupSections, advancedSetupSections, activeSectionLabel, sectionHeading, sectionDescription, activateSection, runRecommendedAction, recommendedActionLabel } = context;
  const editingTpLinkConnection = tpLinkAssignments.find((connection) => connection.id === context.tpLinkEditingConnectionId.current);
  const inheritedPropertyWeather = house.location?.source === "property-location" && house.location.userOverridden !== true;
  const editingTpLinkSourceName = editingTpLinkConnection?.sourceAlias ?? editingTpLinkConnection?.sourceModel
    ?? (editingTpLinkConnection ? t("setup.sourceUnknownName") : null);
  const reusableTpLinkSources = selectedDiscoveredTpLink && !editingTpLinkConnection
    ? tpLinkAssignments.filter((connection) => connection.host !== selectedDiscoveredTpLink.host) : [];
  const reusableTpLinkCredentialSource = reusableTpLinkSources.find((connection) => (
    connection.houseId === house.id && connection.connected
  )) ?? reusableTpLinkSources.find((connection) => connection.houseId === house.id)
    ?? reusableTpLinkSources.find((connection) => connection.connected)
    ?? reusableTpLinkSources[0];
  const reusableTpLinkCredentialSourceHome = reusableTpLinkCredentialSource
    ? connectionHouses.find((candidate) => candidate.id === reusableTpLinkCredentialSource.houseId) : undefined;
  const reusableTpLinkCredentialSourceName = reusableTpLinkCredentialSource
    ? reusableTpLinkCredentialSource.sourceAlias ?? reusableTpLinkCredentialSource.sourceModel
      ?? reusableTpLinkCredentialSource.hubModel ?? t("setup.sourceUnknownName") : null;
  const reusableTpLinkCredentialSourceLabel = reusableTpLinkCredentialSourceName
    ? reusableTpLinkCredentialSourceHome && reusableTpLinkCredentialSourceHome.id !== house.id
      ? `${reusableTpLinkCredentialSourceName} · ${reusableTpLinkCredentialSourceHome.name}`
      : reusableTpLinkCredentialSourceName : null;
  const importingWithSavedTpLinkAccount = Boolean(reusableTpLinkCredentialSource
    && reusableTpLinkCredentialSourceLabel && reuseSavedTpLinkAccount);
  const tpLinkInventoryNeedsAttention = Boolean(tpLinkDevicesError || tpLinkInventoryRefreshFailed);
  const aggregateTpLinkErrorVisible = Boolean(integration.tpLink.error)
    && !tpLinkAssignments.some((connection) => connection.error === integration.tpLink.error);
  const showTpLinkSetupStatus = tpLinkAssignments.length === 0
    || tpLinkReadyDevices > 0
    || aggregateTpLinkErrorVisible
    || tpLinkInventoryNeedsAttention
    || refreshingTpLinkInventory
    || tpLinkChildDiscovery.phase !== "idle";
  return (
      <>
        <header className="page-heading">
          <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{activeSectionLabel}</span><h1>{sectionHeading}</h1><p>{sectionDescription}</p></div>
          {!connectionWorkspaceActive && <span className={`integration-pill ${sensorSourceConnected ? "connected" : ""}`}><span aria-hidden="true" />{connectedSourceLabel}</span>}
        </header>
        <div className="setup-workspace-navigation">
        <Tabs
          className="setup-workspace-tabs"
          label={t("setup.workspaceNavigation")}
          items={primarySetupSections.map((section) => ({ id: section.id, label: section.label, detail: section.detail }))}
          selected={activeSection}
          onSelect={activateSection}
          tabId={(section) => `setup-tab-${section}`}
          panelId={(section) => `setup-panel-${section}`}
        />
        <details className="setup-advanced-navigation" open={advancedSetupSections.some((section) => section.id === activeSection) || undefined}>
          <summary>{t("setup.advancedSetup")}</summary>
          <div>
            {advancedSetupSections.map((section) => <button
              key={section.id}
              id={`setup-tab-${section.id}`}
              type="button"
              aria-current={activeSection === section.id ? "page" : undefined}
              onClick={() => activateSection(section.id)}
            ><strong>{section.label}</strong><small>{section.detail}</small></button>)}
          </div>
        </details>
        </div>

        {(activeSection === "overview" || activeSection === "connections") && <div
          id={`setup-panel-${activeSection}`}
          className={`setup-layout setup-workspace-panel ${activeSection}-workspace`}
          role="tabpanel"
          aria-labelledby={`setup-tab-${activeSection}`}
        >
          {activeSection === "connections" && <div className="setup-connection-scope">
            <span className="setup-scope-note"><Home size={16} aria-hidden="true" />{t("setup.connectionsForHome", { home: house.name })}</span>
            <label className="setup-connection-home-picker">
              <span>{t("setup.connectionHome")}</span>
              <select value={house.id} onChange={(event) => selectSetupHouse(event.target.value)}>
                {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
            <small>{t("setup.connectionHomeHelp")}</small>
          </div>}
          {activeSection === "overview" && <section className="panel setup-steps" aria-labelledby="setup-progress-title">
            <div className="panel-header setup-progress"><div><span className="eyebrow" id="setup-progress-title">{t("setup.progress")}</span><small>{nextStep ? t("setup.nextStep") : t("setup.completeTitle")}</small><h2>{nextStep?.title ?? t("setup.completeTitle")}</h2></div><div className="progress-track" role="progressbar" aria-labelledby="setup-progress-title" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completeCount} aria-valuetext={`${completeCount} / ${steps.length}`}><span style={{ width: `${completeCount / steps.length * 100}%` }} /></div></div>
            {nextStep ? <div className="setup-recommended-action">
              <span className="step-icon" aria-hidden="true">{(() => { const Icon = nextStep.icon; return <Icon size={20} />; })()}</span>
              <p>{nextStep.body}</p>
              <span className="setup-recommended-actions">
                <button type="button" className="primary-button" disabled={nextStepIndex === 1 && discovering} onClick={runRecommendedAction}>{nextStepIndex === 1 && discovering ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{nextStepIndex === 1 && discovering ? t("setup.scanning") : recommendedActionLabel}</button>
                <a className="secondary-button" href={locationForRoute("twin", { propertyId: house.propertyId, houseId: house.id })}>{t("setup.skipForNow")}</a>
              </span>
            </div> : <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.completeBody")}</p>}
            <details className="setup-checklist-disclosure">
              <summary>{t("setup.reviewChecklist")}</summary>
              <ol className="step-list">
                {steps.map((step, index) => {
                  const Icon = step.icon;
                  return <li key={step.title} className={step.complete ? "complete" : ""}><span className="step-number">{step.complete ? <Check size={16} aria-hidden="true" /> : index + 1}</span><span className="step-icon" aria-hidden="true"><Icon size={20} /></span><div><h3>{step.title}</h3><p>{step.body}</p></div>{index < steps.length - 1 && <ChevronRight className="step-chevron" size={18} aria-hidden="true" />}</li>;
                })}
              </ol>
            </details>
          </section>}
          <div className="setup-side">
            {activeSection === "connections" && assignmentCount > 0 && <ConnectionSourceManager
              connectionHouses={connectionHouses}
              homeAssistantAssignments={homeAssistantAssignments}
              tpLinkAssignments={tpLinkAssignments}
              busyAssignment={busyAssignment}
              assignmentHouseDrafts={assignmentHouseDrafts}
              assignmentFeedback={assignmentFeedback}
              onAssignmentHouseDraft={(key, houseId) => setAssignmentHouseDrafts((current) => ({ ...current, [key]: houseId }))}
              onMoveHomeAssistant={(fromHouseId, targetHouseId) => void moveHomeAssistantAssignment(fromHouseId, targetHouseId)}
              onDisconnectHomeAssistant={(houseId) => void disconnectHomeAssistantAssignment(houseId)}
              onMoveTpLink={(connectionId, fromHouseId, targetHouseId) => void moveTpLinkAssignment(connectionId, fromHouseId, targetHouseId)}
              onDisconnectTpLink={(connectionId, houseId) => void disconnectTpLinkAssignment(connectionId, houseId)}
              onEditTpLink={(connection) => {
                context.tpLinkEditingConnectionId.current = connection.id;
                changeTpLinkDraft("host", connection.host ?? "");
                setTpLinkFeedback(null);
                setConnectionSetupOpen(true);
                setTpLinkSettingsOpen(true);
                queueMicrotask(() => document.getElementById("tp-link-host")?.focus());
              }}
              formatDateTime={localDateTime}
            />}
            {activeSection === "connections" && integration.tpLink.configured && showTpLinkSetupStatus && <section
              className={`panel tp-link-setup-status ${tpLinkReadyDevices > 0 ? "ready" : ""}`}
              aria-label={t("setup.tpLinkLiveRegion")}
              aria-busy={refreshingTpLinkInventory}
            >
              {tpLinkAssignments.length === 0 && <header className="tp-link-live-header">
                <span className={`tp-link-live-icon ${tpLinkHealthState}`} aria-hidden="true"><Router size={24} /></span>
                <span className="tp-link-live-copy">
                  <h2 id="tp-link-live-status-heading">{tpLinkStatusTitle}</h2>
                  <p>{t(integration.tpLink.connected ? "setup.tpLinkConnectedBody" : "setup.tpLinkConnectingBody")}</p>
                </span>
                <span className={`source-health-pill ${tpLinkHealthState}`} role="status"><span aria-hidden="true" />{tpLinkHealthLabel}</span>
              </header>}

              {tpLinkReadyDevices > 0 && <div className="tp-link-ready-action">
                <span className="tp-link-ready-icon" aria-hidden="true"><ThermometerSun size={20} /></span>
                <span><strong>{t("setup.tpLinkReadyTitle", { count: tpLinkReadyDevices })}</strong><small>{t("setup.tpLinkReadyBody")}</small></span>
                {onOpenSensors && <button type="button" className="primary-button" onClick={() => onOpenSensors()}>{t("setup.tpLinkReadyAction")}</button>}
              </div>}

              {aggregateTpLinkErrorVisible && <div className={`tp-link-live-alert ${integration.tpLink.connected ? "warning" : "error"}`} role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t(integration.tpLink.connected ? "setup.tpLinkWarning" : "setup.tpLinkConnectionError")}</strong><small>{integration.tpLink.error}</small></span></div>}
              {tpLinkInventoryNeedsAttention && <>
                <div className="tp-link-live-alert error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t("setup.tpLinkInventoryError")}</strong><small>{t("setup.tpLinkInventoryErrorDetail")}</small></span></div>
                <div className="tp-link-recovery-action">
                  <button type="button" className="secondary-button" disabled={refreshingTpLinkInventory} onClick={() => void refreshTpLinkInventory()}><RefreshCw size={16} aria-hidden="true" />{t("setup.tpLinkRetryNow")}</button>
                </div>
              </>}
              {refreshingTpLinkInventory && <p className="tp-link-inventory-refresh" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("setup.tpLinkInventoryRefreshing")}</p>}

              {tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-busy={tpLinkChildDiscovery.phase === "settling"}>
                {tpLinkChildDiscovery.phase === "settling" && <>
                  <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                </>}
                {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                  {tpLinkChildDiscovery.phase === "found" && onOpenSensors
                    ? <button type="button" className="primary-button" onClick={() => onOpenSensors()}><ThermometerSun size={16} aria-hidden="true" />{t("setup.tpLinkReadyAction")}</button>
                    : <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>}
                </div>}
              </div>}

            </section>}
            {activeSection === "connections" && integration.tpLink.configured && <details className="panel connection-card connection-tool-disclosure" aria-labelledby="tp-link-history-export-heading">
              <summary className="connection-card-summary">
                <span className="connection-card-summary-copy"><span className="eyebrow">{t("setup.tpLinkHistoryEyebrow")}</span><h2 id="tp-link-history-export-heading">{t("setup.tpLinkHistoryTitle")}</h2><small>{t("setup.tpLinkHistoryDescription")}</small></span>
                <span className="ha-mark" aria-hidden="true"><RefreshCw size={22} /></span>
              </summary>
              <div className="connection-tool-content">
                <div className="connection-tool-actions">
                <button type="button" className="secondary-button" disabled={tpLinkExportJobsLoading || tpLinkExportEnabled === false} onClick={() => void loadTpLinkExportJobs()}>
                  {tpLinkExportJobsLoading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}{t("common.refresh")}
                </button>
                </div>
              {tpLinkExportEnabled === true && tpLinkExportAutomation && <div
                className={`tp-link-live-alert ${tpLinkExportAutomation.operational && tpLinkExportAutomation.mailbox.consecutiveFailures === 0 ? "warning" : "error"}`}
                role={tpLinkExportAutomation.mailbox.consecutiveFailures > 0 ? "alert" : "status"}
              >
                {tpLinkExportAutomation.operational ? <ShieldCheck size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}
                <span>
                  <strong>{t(tpLinkExportAutomation.operational ? "setup.tpLinkHistoryAutomationConfigured" : "setup.tpLinkHistoryAutomationIncomplete")}</strong>
                  <small>
                    {tpLinkExportAutomation.canaryPending ? `${t("setup.tpLinkHistoryCanaryPending")} · ` : ""}
                    {t("setup.tpLinkHistoryMailbox", { waiting: tpLinkExportAutomation.waitingEmails, max: tpLinkExportAutomation.maxPendingEmails })}
                    {tpLinkExportAutomation.mailbox.lastErrorCode ? ` · ${t("setup.tpLinkHistoryMailboxError", { code: tpLinkExportAutomation.mailbox.lastErrorCode, count: tpLinkExportAutomation.mailbox.consecutiveFailures })}` : ""}
                    {tpLinkExportAutomation.lastWorkerSeenAt ? ` · ${t("setup.tpLinkHistoryWorkerSeen", { time: localDateTime(tpLinkExportAutomation.lastWorkerSeenAt) ?? tpLinkExportAutomation.lastWorkerSeenAt })}` : ` · ${t("setup.tpLinkHistoryWorkerNotSeen")}`}
                    {tpLinkExportAutomation.deploymentFingerprintPrefix ? ` · ${t("setup.tpLinkHistoryDeployment", { fingerprint: tpLinkExportAutomation.deploymentFingerprintPrefix })}` : ""}
                  </small>
                </span>
              </div>}
              {tpLinkExportJobsError && <div className="tp-link-live-alert error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t("setup.tpLinkHistoryUnavailable")}</strong><small>{tpLinkExportJobsError}</small></span></div>}
              {tpLinkExportEnabled === null && tpLinkExportJobsLoading && <p className="tp-link-inventory-refresh" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("setup.tpLinkHistoryLoading")}</p>}
              {tpLinkExportEnabled === false && <p className="configured-note" aria-disabled="true"><CircleDot size={17} aria-hidden="true" />{t("setup.tpLinkHistoryDisabled")}</p>}
              {tpLinkExportEnabled === true && tpLinkExportAutomation && canManageIntegrations && <div className="tp-link-live-actions" aria-label={t("setup.tpLinkHistoryCanaryControls")}>
                <label className="field"><span>{t("setup.tpLinkHistoryCanarySensor")}</span><select aria-label={t("setup.tpLinkHistoryCanarySensor")} value={tpLinkCanarySensorId} disabled={tpLinkCanaryRunning || tpLinkCanaryTargets.length === 0} onChange={(event) => setTpLinkCanarySensorId(event.target.value)}>{tpLinkCanaryTargets.length === 0 ? <option value="">{t("setup.tpLinkHistoryNoMappedTarget")}</option> : tpLinkCanaryTargets.map((target) => <option key={target.sensorId} value={target.sensorId}>{target.label}</option>)}</select></label>
                <label className="field"><span>{t("common.metric")}</span><select aria-label={t("setup.tpLinkHistoryCanaryMetric")} value={tpLinkCanaryMetric} disabled={tpLinkCanaryRunning} onChange={(event) => setTpLinkCanaryMetric(event.target.value as "temperature" | "humidity")}><option value="temperature">{t("common.temperature")}</option><option value="humidity">{t("common.humidity")}</option></select></label>
                <button type="button" className="primary-button" disabled={tpLinkCanaryRunning || !tpLinkCanarySensorId} onClick={() => void runTpLinkCanary()}>{tpLinkCanaryRunning ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}{t("setup.tpLinkHistoryRunCanary")}</button>
              </div>}
              {tpLinkExportEnabled === true && tpLinkExportAutomation && canManageIntegrations && <p className="setup-help">{t("setup.tpLinkHistoryCanaryHelp")}</p>}
              {tpLinkExportEnabled === true && !tpLinkExportJobsLoading && tpLinkExportJobs.length === 0 && <p className="setup-help">{t("setup.tpLinkHistoryNoJobs")}</p>}
                {tpLinkExportEnabled === true && tpLinkExportJobs.length > 0 && <div className="table-scroll" tabIndex={0} aria-label={t("setup.tpLinkHistoryJobsLabel")}>
                <table>
                  <thead><tr><th scope="col">{t("setup.tpLinkHistoryColumnStatus")}</th><th scope="col">{t("setup.tpLinkHistoryColumnProvider")}</th><th scope="col">{t("setup.tpLinkHistoryColumnDevice")}</th><th scope="col">{t("setup.tpLinkHistoryColumnRange")}</th><th scope="col">{t("setup.tpLinkHistoryColumnAttempt")}</th><th scope="col">{t("setup.tpLinkHistoryColumnError")}</th><th scope="col">{t("setup.tpLinkHistoryColumnActions")}</th></tr></thead>
                  <tbody>{tpLinkExportJobs.map((job) => {
                    const deviceLabel = job.deviceName || job.deviceId;
                    const busy = busyTpLinkExportJobId === job.id;
                    const problem = job.lastError ?? job.attentionReason ?? job.detail;
                    return <tr key={job.id}>
                      <td><strong>{t(TP_LINK_EXPORT_STATUS_KEYS[job.status])}</strong>{job.canary && <><br /><small>{t("setup.tpLinkHistoryCanary")}</small></>}</td>
                      <td>{t(TP_LINK_EXPORT_PROVIDER_KEYS[job.provider])}</td>
                      <td><strong>{deviceLabel}</strong><br /><small>{job.deviceId}</small></td>
                      <td><time dateTime={job.from}>{localDateTime(job.from) ?? job.from}</time><br /><small>{t("setup.tpLinkHistoryRangeTo")} <time dateTime={job.to}>{localDateTime(job.to) ?? job.to}</time></small></td>
                      <td>{job.attemptCount} / {job.maxAttempts}</td>
                      <td>{problem ? <small>{problem}</small> : "—"}</td>
                      <td><div className="tp-link-live-actions">
                        {canManageIntegrations && RETRYABLE_TP_LINK_EXPORT_STATUSES.has(job.status) && <button type="button" className="secondary-button" disabled={busyTpLinkExportJobId !== null} aria-label={t("setup.tpLinkHistoryRetryLabel", { device: deviceLabel })} onClick={() => void retryTpLinkExportJob(job)}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{t("setup.tpLinkHistoryRetry")}</button>}
                        {canManageIntegrations && ACTIVE_TP_LINK_EXPORT_STATUSES.has(job.status) && <button type="button" className="danger-button" disabled={busyTpLinkExportJobId !== null} aria-label={t("setup.tpLinkHistoryCancelLabel", { device: deviceLabel })} onClick={() => void cancelTpLinkExportJob(job)}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("common.cancel")}</button>}
                        {(!canManageIntegrations || (!RETRYABLE_TP_LINK_EXPORT_STATUSES.has(job.status) && !ACTIVE_TP_LINK_EXPORT_STATUSES.has(job.status))) && <small>{t("setup.tpLinkHistoryNoAction")}</small>}
                      </div></td>
                    </tr>;
                  })}</tbody>
                </table>
                </div>}
              </div>
            </details>}
            {activeSection === "connections" && <details id="connection-setup-disclosure" className={`panel connection-card discovery-card ${sensorSourceConfigured ? "optional" : ""}`} aria-labelledby="network-discovery-heading" open={connectionSetupOpen} onToggle={(event) => setConnectionSetupOpen(event.currentTarget.open)}>
              <summary className="connection-card-summary">
                <span className="connection-card-summary-copy"><span className="eyebrow">{t(sensorSourceConfigured ? "setup.addConnectionEyebrow" : "setup.scanTitle")}</span><strong id="network-discovery-heading">{t(sensorSourceConfigured ? "setup.addConnectionTitle" : "setup.scanDescription")}</strong><small>{t(sensorSourceConfigured ? "setup.addConnectionDescription" : "setup.scanScope")}</small></span>
                <span className="ha-mark" aria-hidden="true"><RadioTower size={22} /></span>
              </summary>
              <div className="discovery-card-content">
                <div className="connection-check guided-setup">
                {!discovering && <button type="button" className={`${sensorSourceConfigured ? "secondary-button" : "primary-button"} full-width`} onClick={() => void scanIntegrations()}><RefreshCw size={17} aria-hidden="true" />{t(sensorSourceConfigured ? "setup.findAdditionalSystems" : "setup.scan")}</button>}
                <div className={`setup-discovery-feedback ${discovering ? "running" : discoveryOutcome}`} aria-live="polite" aria-busy={discovering}>
                  {discovering && <p className="setup-discovery-message" role="status"><LoaderCircle className="spin setup-discovery-spin-icon" size={18} aria-hidden="true" /><Hourglass className="setup-discovery-wait-icon" size={18} aria-hidden="true" /><span><strong>{t("setup.scanning")}</strong><small>{t("setup.scanProgress")}</small></span></p>}
                  {!discovering && discoveryOutcome === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.scanFound", { count: discoveredCount })}</strong><small>{t("setup.scanComplete")}</small></span></p>}
                  {!discovering && discoveryOutcome === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t(sensorSourceConfigured ? "setup.scanAdditionalEmpty" : "setup.scanEmpty")}</strong><small>{t(sensorSourceConfigured ? "setup.scanAdditionalEmptyDetail" : "setup.noDevices")}</small></span></p>}
                  {!discovering && discoveryOutcome === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.scanError")}</strong><small>{t("setup.scanPartial")}</small></span></p>}
                  {!discovering && discoveryOutcome === "found" && (discovery?.warnings.length ?? 0) > 0 && <p className="setup-discovery-partial"><TriangleAlert size={15} aria-hidden="true" />{t("setup.scanPartial")}</p>}
                  {!discovering && discovery && discovery.warnings.length > 0 && <ul className="setup-discovery-warnings">{discovery.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
                </div>
                <details className="advanced-setup tp-link-compatibility-help">
                  <summary>{t("setup.tapoCompatibilityTitle")}</summary>
                  <p className="setup-scan-scope">{t("setup.tapoCompatibilityHelp")}</p>
                </details>
                </div>
              </div>
            </details>}
            {activeSection === "connections" && <SetupProviderGrid label={t("setup.connectionMethods")}>
            <CredentialControls allowed={canManageIntegrations} explain={false}><GreeSetupPanel house={house} integration={integration} devices={discovery?.gree ?? []} onIntegrationChange={onIntegrationChange} /></CredentialControls>
            {canManageIntegrations && <TuyaSetupPanel house={house} integration={integration} onIntegrationChange={onIntegrationChange} />}
            {canManageIntegrations && <Nexus433SetupPanel house={house} onOpenSensors={onOpenSensors} />}
            <section className="panel connection-card connection-provider" aria-labelledby="direct-connection-heading">
              <div className="panel-header"><div><span className="eyebrow">{t("setup.directTitle")}</span><h2 id="direct-connection-heading">{t("setup.directConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Router size={22} /></span></div>
              <p className="connection-card-description">{t("setup.directDescription")}</p>
              {tpLinkFeedback?.kind === "success" && !tpLinkSettingsOpen && <p className="configured-note connection-save-confirmation" role="status" aria-live="polite"><Check size={17} aria-hidden="true" /><span>{tpLinkFeedback.message}</span></p>}
              <details className="setup-config-disclosure" open={tpLinkSettingsOpen} onToggle={(event) => {
                setTpLinkSettingsOpen(event.currentTarget.open);
                if (event.currentTarget.open && tpLinkFeedback?.kind === "success") setTpLinkFeedback(null);
                if (!event.currentTarget.open) context.tpLinkEditingConnectionId.current = null;
              }}>
                <summary><span><Router size={16} aria-hidden="true" />{editingTpLinkSourceName
                  ? t("setup.updateSourceTitle", { source: editingTpLinkSourceName })
                  : selectedDiscoveredTpLink
                    ? t("setup.addDiscoveredTpLinkTitle", { device: selectedDiscoveredTpLink.alias ?? `TP-Link ${selectedDiscoveredTpLink.model}` })
                    : t("setup.manualConnection")}</span><small>{editingTpLinkConnection?.host
                       ?? (selectedDiscoveredTpLink
                         ? `${selectedDiscoveredTpLink.model} · ${selectedDiscoveredTpLink.host}`
                         : t("setup.manualHost"))}</small></summary>
              {discovery && discovery.tpLink.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectTpLink")}</legend>{discovery.tpLink.map((source) => <label key={source.host}><input type="radio" name="tp-link-discovery" value={source.host} checked={tpLinkHost === source.host} disabled={savingTpLink} onChange={() => changeTpLinkDraft("host", source.host)} /><span><strong>{source.alias ?? `TP-Link ${source.model}`}</strong><small>{t(source.sourceType === "energy-device" ? "setup.tpLinkEnergyDevice" : "setup.tpLinkHub")} · {source.model} · {source.host}</small></span></label>)}</fieldset>}
              <p className="setup-help setup-child-discovery-explainer">{t(selectedDiscoveredTpLink
                ? reusableTpLinkCredentialSource ? "setup.reuseDiscoveredTpLinkDescription" : "setup.addDiscoveredTpLinkDescription"
                : editingTpLinkSourceName ? "setup.tpLinkSettingsDescription"
                  : integration.tpLink.configured ? "setup.addManualTpLinkDescription" : "setup.childDiscoveryExplainer")}</p>
              {!integration.tpLink.configured && (discoveryOutcome === "error" || (discovery && discovery.tpLink.length === 0)) && <p className="setup-help setup-manual-fallback">{t("setup.tpLinkManualFallback")}</p>}
              {tpLinkSettingsOpen && <CredentialControls allowed={canManageIntegrations}><form className="connection-check guided-setup" onSubmit={(event) => void saveTpLink(
                event,
                importingWithSavedTpLinkAccount ? reusableTpLinkCredentialSource?.id : undefined,
              )}>
                {editingTpLinkSourceName
                  ? <p className="configured-note"><Pencil size={17} aria-hidden="true" />{t("setup.updatingSource", { source: editingTpLinkSourceName })}</p>
                  : null}
                <label className="field" htmlFor="tp-link-host"><span>{t("setup.host")}</span><input id="tp-link-host" type="text" value={tpLinkHost} maxLength={253} placeholder={t("setup.hostPlaceholder")} aria-describedby="tp-link-host-help" autoCapitalize="none" autoCorrect="off" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("host", event.target.value)} required /></label>
                <p className="setup-help" id="tp-link-host-help">{t("setup.hostHelp")}</p>
                {reusableTpLinkCredentialSource && reusableTpLinkCredentialSourceLabel && <fieldset className="discovery-results tp-link-account-options">
                  <legend>{t("setup.tpLinkAccountChoice")}</legend>
                  <label>
                    <input type="radio" name="tp-link-account-choice" value="saved" checked={reuseSavedTpLinkAccount} disabled={savingTpLink} onChange={() => {
                      setReuseSavedTpLinkAccount(true);
                      setTpLinkFeedback(null);
                    }} />
                    <span><strong>{t("setup.reuseSavedTpLinkAccount")}</strong><small>{t("setup.reuseSavedTpLinkAccountHelp", { source: reusableTpLinkCredentialSourceLabel })}</small></span>
                  </label>
                  <label>
                    <input type="radio" name="tp-link-account-choice" value="different" checked={!reuseSavedTpLinkAccount} disabled={savingTpLink} onChange={() => {
                      setReuseSavedTpLinkAccount(false);
                      setTpLinkFeedback(null);
                    }} />
                    <span><strong>{t("setup.useDifferentTpLinkAccount")}</strong><small>{t("setup.useDifferentTpLinkAccountHelp")}</small></span>
                  </label>
                </fieldset>}
                {!importingWithSavedTpLinkAccount && <>
                  <label className="field" htmlFor="tp-link-username"><span>{t("setup.username")}</span><input id="tp-link-username" type="email" value={tpLinkUsername} maxLength={320} aria-describedby="tp-link-username-help" autoComplete="username" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("username", event.target.value)} required /></label>
                  <p className="setup-help" id="tp-link-username-help">{t("setup.usernameHelp")}</p>
                  <label className="field" htmlFor="tp-link-password"><span>{t("setup.password")}</span><input id="tp-link-password" type={showTpLinkPassword ? "text" : "password"} value={tpLinkPassword} maxLength={4096} autoComplete="current-password" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("password", event.target.value)} required /></label>
                  <label className="show-secret"><input type="checkbox" checked={showTpLinkPassword} onChange={(event) => setShowTpLinkPassword(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
                  <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
                </>}
                {importingWithSavedTpLinkAccount && <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.savedTpLinkAccountSecurity")}</p>}
                <button type="submit" className="primary-button full-width" disabled={savingTpLink || testingDirect}>{savingTpLink ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingTpLink
                  ? t("common.saving")
                  : importingWithSavedTpLinkAccount
                    ? t("setup.importTpLinkDevice", { device: selectedDiscoveredTpLink?.alias ?? selectedDiscoveredTpLink?.model ?? t("setup.tpLinkEnergyDevice") })
                    : t("setup.saveConnect")}</button>
                {tpLinkFeedback && <p className={`test-result ${tpLinkFeedback.kind}`} role={tpLinkFeedback.kind === "error" ? "alert" : "status"}>{tpLinkFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{tpLinkFeedback.message}</p>}
                {!integration.tpLink.configured && tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-live="polite" aria-busy={tpLinkChildDiscovery.phase === "settling"}>
                  {tpLinkChildDiscovery.phase === "settling" && <>
                    <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                  </>}
                  {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                    {tpLinkChildDiscovery.phase === "found" && onOpenSensors
                      ? <button type="button" className="primary-button" onClick={() => onOpenSensors()}><ThermometerSun size={16} aria-hidden="true" />{t("setup.tpLinkReadyAction")}</button>
                      : <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>}
                  </div>}
                </div>}
                {!importingWithSavedTpLinkAccount && <>
                  <button type="button" className="secondary-button full-width" disabled={testingDirect || savingTpLink} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
                  {directResult && <p className={`test-result ${directResult}`} role={directResult === "failure" ? "alert" : "status"}>{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
                  <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label={t("setup.directEnvironmentVariables")}><code>TP_LINK_HOST=192.0.2.10{"\n"}TP_LINK_USERNAME=user@example.com{"\n"}TP_LINK_PASSWORD=••••••••</code></pre></details>
                </>}
              </form></CredentialControls>}
              </details>
            </section>
            <section className="panel connection-card connection-provider" aria-labelledby="connection-heading">
              <div className="panel-header"><div><span className="eyebrow">Home Assistant</span><h2 id="connection-heading">{t("setup.homeAssistantConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Home size={22} /></span></div>
              <p className="connection-card-description">{t("setup.homeAssistantConnectionDescription")}</p>
              <details className="setup-config-disclosure">
                <summary><span><Home size={16} aria-hidden="true" />{selectedDiscoveredHomeAssistant?.name ?? t("setup.manualConnection")}</span><small>{selectedDiscoveredHomeAssistant ? selectedDiscoveredHomeAssistant.url : t("setup.manualService")}</small></summary>
              {discovery && discovery.homeAssistant.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectHomeAssistant")}</legend>{discovery.homeAssistant.map((instance) => <label key={instance.url}><input type="radio" name="home-assistant-discovery" value={instance.url} checked={haUrl === instance.url} disabled={savingHomeAssistant} onChange={() => changeHomeAssistantDraft("url", instance.url)} /><span><strong>{instance.name}</strong><small>{instance.url}{instance.version ? ` · ${instance.version}` : ""}</small></span></label>)}</fieldset>}
              <CredentialControls allowed={canManageIntegrations}>
              <form className="connection-check guided-setup" onSubmit={(event) => void saveHomeAssistant(event)}>
                {integration.homeAssistant.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
                <label className="field" htmlFor="home-assistant-url"><span>{t("setup.haUrl")}</span><input id="home-assistant-url" type="url" value={haUrl} maxLength={2048} placeholder={t("setup.haUrlPlaceholder")} aria-describedby="home-assistant-url-help" autoCapitalize="none" autoCorrect="off" disabled={savingHomeAssistant} onChange={(event) => changeHomeAssistantDraft("url", event.target.value)} required /></label>
                <p className="setup-help" id="home-assistant-url-help">{t("setup.haUrlHelp")}</p>
                <label className="field" htmlFor="home-assistant-token"><span>{t("setup.token")}</span><input id="home-assistant-token" type={showHaToken ? "text" : "password"} value={haToken} maxLength={8192} placeholder={t("setup.tokenPlaceholder")} aria-describedby="home-assistant-token-help" autoComplete="off" disabled={savingHomeAssistant} onChange={(event) => changeHomeAssistantDraft("token", event.target.value)} required /></label>
                <p className="setup-help" id="home-assistant-token-help">{t("setup.tokenHelp")}</p>
                <label className="show-secret"><input type="checkbox" checked={showHaToken} onChange={(event) => setShowHaToken(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
                <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
                <button type="submit" className="primary-button full-width" disabled={savingHomeAssistant || testing}>{savingHomeAssistant ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingHomeAssistant ? t("common.saving") : t("setup.saveConnect")}</button>
                {homeAssistantFeedback && <p className={`test-result ${homeAssistantFeedback.kind}`} role={homeAssistantFeedback.kind === "error" ? "alert" : "status"}>{homeAssistantFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{homeAssistantFeedback.message}</p>}
                <button type="button" className="secondary-button full-width" disabled={testing || savingHomeAssistant} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{testing ? t("setup.scanning") : t("common.test")}</button>
                {result && <p className={`test-result ${result}`} role={result === "failure" ? "alert" : "status"}>{result === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{result === "success" ? t("setup.testSuccess") : t("setup.testFailure")}</p>}
                <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label={t("setup.homeAssistantEnvironmentVariables")}><code>HA_URL=http://homeassistant.local:8123{"\n"}HA_TOKEN=••••••••</code></pre></details>
              </form>
              </CredentialControls>
               </details>
             </section>
            </SetupProviderGrid>}
            {activeSection === "overview" && <details className="panel setup-status-disclosure">
              <summary><span>{t("setup.connectedServices")}</span><small>{connectedSourceLabel}</small></summary>
              <div className="integration-status" aria-label={t("status.dataSource")}>
              <div><span className={`status-symbol ${integration.tpLink.connected ? "positive" : ""}`}><Router size={17} aria-hidden="true" /></span><span><strong>TP-Link {integration.tpLink.hubModel ?? (integration.tpLink.connected ? t("setup.tpLinkEnergyDevice") : t("setup.tpLinkDefault"))}</strong><small>{integration.tpLink.lastPollAt ? t("setup.lastPoll", { time: localDateTime(integration.tpLink.lastPollAt) ?? "—" }) : t("setup.mappedDevices", { count: integration.tpLink.mappedDevices })}</small></span><b>{integration.tpLink.connected ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.homeAssistant.connected ? "positive" : ""}`}><Home size={17} aria-hidden="true" /></span><span><strong>Home Assistant</strong><small>{t("setup.mapped", { count: integration.homeAssistant.mappedEntities })}</small></span><b>{integration.homeAssistant.connected ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{integration.mock.mode === "real" ? t("setup.mockLocked") : t("setup.mockEnabled")}</strong><small>{integration.mock.mode === "real" ? t("setup.realDataMode") : `${integration.mock.intervalMs / 1000}s`}</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? (integration.weather.lastSuccessAt ? t("weather.lastSuccess", { time: localDateTime(integration.weather.lastSuccessAt) ?? "—" }) : t(countKey(integration.weather.configuredHouses, "weather.configuredHousesOne", "weather.configuredHouses"), { count: integration.weather.configuredHouses }))}</small></span><b>{t("setup.automatic")}</b></div>
              </div>
            </details>}
          </div>
        </div>}

        {activeSection === "weather" && <section
          id="setup-panel-weather"
          className="weather-section setup-workspace-panel weather-workspace"
          role="tabpanel"
          aria-labelledby={`setup-tab-${activeSection}`}
        >
          <header className="weather-heading">
            <div><span className="eyebrow"><CloudSun size={14} aria-hidden="true" />{house.name}</span><h2>{t("setup.advancedWeather")}</h2></div>
            <div className="weather-heading-actions">
              <label className="weather-house-picker"><span>{t("common.house")}</span><select value={house.id} onChange={(event) => selectSetupHouse(event.target.value)}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
              <span className={`weather-freshness ${house.location ? "fresh" : "stale"}`}>{house.location ? <Check size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />}{house.location ? t("weather.locationSet") : t("weather.locationMissing")}</span>
            </div>
          </header>

          <div className="weather-location-grid">

            {activeSection === "weather" && <section className="panel setup-weather-config-card" aria-labelledby="weather-reference-title">
              <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h3 id="weather-reference-title">{t("placement.weatherReference")}</h3></div><span className="weather-card-icon"><CloudSun size={20} aria-hidden="true" /></span></div>
              <p className="weather-card-description">{t("placement.weatherDescription")}</p>
              <LocationDiscoveryPanel key={house.id} {...(house.location ? { currentLocation: house.location } : {})} currentTimezone={house.timezone} onApply={applyDiscoveredDefaults} />
              <div className="setup-config-summary">
                <div><span>{t("setup.provider")}</span><strong>{t("setup.weatherService")}</strong><small>{t("setup.providerAutomatic")}</small></div>
                <div><span>{t("setup.timezone")}</span><strong>{house.timezone}</strong><small>{t("setup.timezoneManaged")}</small></div>
                <div><span>{t("placement.weatherReference")}</span><strong>{house.location?.label ?? (house.location ? `${decimal(house.location.latitude, locale, 4)}, ${decimal(house.location.longitude, locale, 4)}` : t("weather.locationMissing"))}</strong><small>{inheritedPropertyWeather ? t("properties.weatherInherited") : house.location ? t("weather.locationSet") : t("setup.weatherNeeded")}</small></div>
              </div>
              {house.mapPlacement && <button type="button" className="primary-button setup-use-placement" disabled={savingLocation} onClick={() => void savePlacementForWeather()}>{savingLocation ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LocateFixed size={16} aria-hidden="true" />}{house.location ? t("setup.syncWeatherLocation") : t("placement.useForWeather")}</button>}
              <details className="setup-config-disclosure weather-reference-details">
                <summary><span><MapPin size={15} aria-hidden="true" />{t("setup.advancedWeather")}</span><small>{t("setup.manualCoordinates")}</small></summary>
                <p>{t("setup.advancedWeatherDescription")}</p>
                <div className="weather-location-fields">
                  <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={latitude} aria-invalid={coordinateValidationVisible || undefined} aria-describedby={coordinateValidationVisible ? "weather-coordinate-error" : undefined} onChange={(event) => { setLatitude(event.target.value); setLocationFeedback(null); }} required /></label>
                  <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={longitude} aria-invalid={coordinateValidationVisible || undefined} aria-describedby={coordinateValidationVisible ? "weather-coordinate-error" : undefined} onChange={(event) => { setLongitude(event.target.value); setLocationFeedback(null); }} required /></label>
                  <label className="field weather-location-label"><span>{t("weather.locationLabel")} <small>{t("common.optional")}</small></span><input type="text" maxLength={200} value={locationLabel} placeholder={t("weather.locationPlaceholder")} onChange={(event) => setLocationLabel(event.target.value)} /></label>
                  <label className="field weather-location-label"><span>{t("setup.timezone")}</span><input type="text" value={timezone} placeholder="Europe/Helsinki" autoCapitalize="none" autoCorrect="off" aria-invalid={timezoneValidationVisible || undefined} aria-describedby={timezoneValidationVisible ? "weather-timezone-error" : undefined} onChange={(event) => { setTimezone(event.target.value); setLocationFeedback(null); }} required /></label>
                  {coordinateValidationVisible && <p id="weather-coordinate-error" className="field-error weather-location-error" role="alert">{t("weather.invalidLocation")}</p>}
                  {timezoneValidationVisible && <p id="weather-timezone-error" className="field-error weather-location-error" role="alert">{t("weather.invalidTimezone")}</p>}
                </div>
                <div className="weather-location-actions">
                  <button type="button" className="secondary-button" disabled={!house.mapPlacement && !draftMapLocation} onClick={usePlacementForWeather}><LocateFixed size={15} aria-hidden="true" />{t("placement.useForWeather")}</button>
                  <button type="button" className="primary-button" disabled={savingLocation} onClick={() => void saveLocation()}>{savingLocation ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}{savingLocation ? t("common.saving") : t("weather.saveLocation")}</button>
                  {house.location && !inheritedPropertyWeather && <button type="button" className="secondary-button" disabled={savingLocation} onClick={() => void removeLocation()}><Trash2 size={16} aria-hidden="true" />{t("weather.removeLocation")}</button>}
                </div>
              </details>
              {locationFeedback && <p className={`weather-feedback ${locationFeedback.kind}`} role={locationFeedback.kind === "error" ? "alert" : "status"}>{locationFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{locationFeedback.message}</p>}
            </section>}

            {activeSection === "weather" && <section className="panel setup-system-card" aria-labelledby="setup-system-title">
              <div className="panel-header"><div><span className="eyebrow">{t("setup.systemEyebrow")}</span><h3 id="setup-system-title">{t("setup.systemTitle")}</h3></div><span className="weather-card-icon current"><RadioTower size={20} aria-hidden="true" /></span></div>
              <p className="weather-card-description">{t("setup.systemDescription")}</p>
              <div className="integration-status compact-status">
                <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? t(countKey(integration.weather.configuredHouses, "weather.configuredHousesOne", "weather.configuredHouses"), { count: integration.weather.configuredHouses })}</small></span><b>{t("setup.automatic")}</b></div>
                <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{integration.mock.mode === "real" ? t("setup.mockLocked") : t("setup.mockEnabled")}</strong><small>{integration.mock.mode === "real" ? t("setup.realDataMode") : `${integration.mock.intervalMs / 1000}s`}</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
                <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
              </div>
            </section>}

          </div>

        </section>}

        {activeSection === "layout" && <section
          id="setup-panel-layout"
          className="setup-workspace-panel layout-workspace"
          role="tabpanel"
          aria-labelledby="setup-tab-layout"
        >
          <section className="panel setup-layout-card">
            <CardHeader title={t("setup.layoutTitle")} eyebrow={house.name} aside={<Building2 size={22} aria-hidden="true" />} />
            <p>{t("setup.layoutDescription")}</p>
            <div className="setup-config-summary">
              <div><span>{t("common.floor")}</span><strong>{house.floors.length}</strong><small>{t("setup.workspaceLayoutDetail", { count: house.floors.length })}</small></div>
              <div><span>{t("setup.layoutRooms")}</span><strong>{house.floors.reduce((count, floor) => count + floor.rooms.length, 0)}</strong><small>{t("setup.layoutRoomsDetail")}</small></div>
            </div>
            {onOpenLayout && <button type="button" className="primary-button" onClick={onOpenLayout}><Building2 size={16} aria-hidden="true" />{t("setup.openLayoutEditor")}</button>}
          </section>
        </section>}

        {activeSection === "automations" && <section
          id="setup-panel-automations"
          className="setup-workspace-panel automations-workspace"
          role="tabpanel"
          aria-labelledby="setup-tab-automations"
        >
          <AutomationSetupPanel
            integration={integration}
            house={house}
            houses={houses}
            onHouse={selectSetupHouse}
            onIntegrationChange={onIntegrationChange}
          />
        </section>}

        {activeSection === "operations" && <section
          id="setup-panel-operations"
          className="setup-workspace-panel"
          role="tabpanel"
          aria-labelledby="setup-tab-operations"
        >
          <SetupOperationsPanel house={house} canManageSystem={canManageIntegrations === true} />
        </section>}

        {setupSectionOrder.filter((section) => section !== activeSection).map((section) => (
          <div
            key={section}
            id={`setup-panel-${section}`}
            role="tabpanel"
            aria-labelledby={`setup-tab-${section}`}
            hidden
          />
        ))}
      </>
    );
}
