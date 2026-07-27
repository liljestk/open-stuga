import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  CircleDot,
  CloudSun,
  Compass,
  ExternalLink,
  Home,
  LocateFixed,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Maximize2,
  Move,
  RadioTower,
  RefreshCw,
  Router,
  Ruler,
  ShieldCheck,
  ThermometerSun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  ConnectionState,
  House,
  HouseLocation,
  HouseMapPlacement,
  IntegrationStatus,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import {
  api,
  type HouseGeoreferencePatch,
  type HousePatch,
  type IntegrationDiscoveryResult,
  type TpLinkHistoryExportJob,
  type TpLinkHistoryExportJobsResponse,
  type TpLinkHistoryExportJobStatus,
} from "../../api";
import type { HouseLocationMapItem, MapLocation } from "../../components/HouseLocationMap";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { integrationForHouse } from "../../integrationScope";
import { AutomationSetupPanel } from "../AutomationSetupPanel";
import { SetupOperationsPanel } from "../SetupOperationsPanel";
import { ACTIVE_TP_LINK_EXPORT_STATUSES, HouseLocationMap, RETRYABLE_TP_LINK_EXPORT_STATUSES, TP_LINK_CHILD_DISCOVERY_ATTEMPTS, TP_LINK_CHILD_DISCOVERY_INTERVAL_MS, TP_LINK_EXPORT_PROVIDER_KEYS, TP_LINK_EXPORT_STATUS_KEYS, connectionError, dateTime, decimal, defaultFootprintWidthMeters, floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, setupSectionOrder, validTimeZone, waitForChildDiscoveryAttempt, writeSetupSection } from "./support";
import type { DiscoveryOutcome, Feedback, HouseFloor, IntegrationsPageProps, SetupSection, TpLinkChildDiscovery } from "./support";
import { useIntegrationsPagePart06 } from "./part-06";
export function renderIntegrationsPage(context: ReturnType<typeof useIntegrationsPagePart06>) {
  const { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, locale, t, setupHouseId, setSetupHouseId, house, integration, activeSection, setActiveSection, mapLoaded, setMapLoaded, testing, setTesting, result, setResult, homeAssistantTestGeneration, discoveryGeneration, automaticallyScannedHouseId, inventoryRefreshGeneration, historyExportRequestGeneration, testingDirect, setTestingDirect, directResult, setDirectResult, tpLinkTestGeneration, validatedTpLinkDraft, setValidatedTpLinkDraft, discovering, setDiscovering, discovery, setDiscovery, discoveryOutcome, setDiscoveryOutcome, tpLinkSettingsOpen, setTpLinkSettingsOpen, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, showTpLinkPassword, setShowTpLinkPassword, savingTpLink, setSavingTpLink, tpLinkFeedback, setTpLinkFeedback, refreshingTpLinkInventory, setRefreshingTpLinkInventory, tpLinkInventoryRefreshFailed, setTpLinkInventoryRefreshFailed, tpLinkExportEnabled, setTpLinkExportEnabled, tpLinkExportJobs, setTpLinkExportJobs, tpLinkExportAutomation, setTpLinkExportAutomation, tpLinkExportJobsLoading, setTpLinkExportJobsLoading, tpLinkExportJobsError, setTpLinkExportJobsError, busyTpLinkExportJobId, setBusyTpLinkExportJobId, tpLinkCanaryTargets, setTpLinkCanaryTargets, tpLinkCanarySensorId, setTpLinkCanarySensorId, tpLinkCanaryMetric, setTpLinkCanaryMetric, tpLinkCanaryRunning, setTpLinkCanaryRunning, tpLinkChildDiscovery, setTpLinkChildDiscovery, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, showHaToken, setShowHaToken, savingHomeAssistant, setSavingHomeAssistant, homeAssistantFeedback, setHomeAssistantFeedback, busyAssignment, setBusyAssignment, assignmentHouseDrafts, setAssignmentHouseDrafts, assignmentFeedback, setAssignmentFeedback, validatedHomeAssistantDraft, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, placementEditing, setPlacementEditing, mapViewport, setMapViewport, orientation, setOrientation, savingLocation, setSavingLocation, locationFeedback, setLocationFeedback, savingPlacement, setSavingPlacement, placementFeedback, setPlacementFeedback, activeSetupHouseId, locationRequestGeneration, placementRequestGeneration, localDateTime, managedHouseIds, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, stopTpLinkChildDiscovery, tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment, disconnectTpLinkAssignment, moveHomeAssistantAssignment, moveTpLinkAssignment, testConnection, testDirectConnection, updateTpLinkCanaryTargets, loadTpLinkCanaryTargets, refreshTpLinkInventory, loadTpLinkExportJobs, runTpLinkCanary, retryTpLinkExportJob, cancelTpLinkExportJob, scanIntegrations, settleTpLinkChildren, saveTpLink, saveHomeAssistant, saveLocation, removeLocation, resetPlacementDraft, savePlacement, removePlacement, clearOrientation, updateFromMap, usePlacementForWeather, savePlacementForWeather, applyDiscoveredDefaults, discoveredCount, sensorHardwareDetected, sensorSourceConfigured, sensorSourceConnected, mappedSensorSources, tpLinkReadyDevices, tpLinkHubName, connectedSourceCount, assignmentCount, connectedSourceLabel, streamStatusLabel, tpLinkHealthState, tpLinkHealthLabel, tpLinkStatusTitle, connectionWorkspaceActive, steps, completeCount, nextStepIndex, nextStep, weatherHomes, notesGrantCount, selectedDiscoveredTpLink, selectedDiscoveredHomeAssistant, setupSections, activeSectionLabel, sectionHeading, sectionDescription, activateSection, handleSectionKeyDown, runRecommendedAction, recommendedActionLabel } = context;
  return (
      <>
        <header className="page-heading">
          <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{activeSectionLabel}</span><h1>{sectionHeading}</h1><p>{sectionDescription}</p></div>
          {!connectionWorkspaceActive && <span className={`integration-pill ${sensorSourceConnected ? "connected" : ""}`}><span aria-hidden="true" />{connectedSourceLabel}</span>}
        </header>
        <div className="setup-workspace-tabs" role="tablist" aria-label={t("setup.workspaceNavigation")}>
          {setupSections.map((section) => (
            <button
              key={section.id}
              id={`setup-tab-${section.id}`}
              type="button"
              role="tab"
              aria-selected={activeSection === section.id}
              aria-controls={`setup-panel-${section.id}`}
              tabIndex={activeSection === section.id ? 0 : -1}
              onClick={() => activateSection(section.id)}
              onKeyDown={(event) => handleSectionKeyDown(event, section.id)}
            >
              <strong>{section.label}</strong><small>{section.detail}</small>
            </button>
          ))}
        </div>

        {(activeSection === "overview" || activeSection === "connections") && <div
          id={`setup-panel-${activeSection}`}
          className={`setup-layout setup-workspace-panel ${activeSection === "connections" ? "connections-workspace" : ""}`}
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
              <button type="button" className="primary-button" disabled={nextStepIndex === 0 && discovering} onClick={runRecommendedAction}>{nextStepIndex === 0 && discovering ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{nextStepIndex === 0 && discovering ? t("setup.scanning") : recommendedActionLabel}</button>
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
            {activeSection === "connections" && integration.tpLink.configured && <section
              className={`panel tp-link-live-status ${tpLinkHealthState}`}
              aria-label={t("setup.tpLinkLiveRegion")}
              aria-busy={tpLinkDevicesLoading || refreshingTpLinkInventory}
            >
              <header className="tp-link-live-header">
                <span className={`tp-link-live-icon ${tpLinkHealthState}`} aria-hidden="true"><Router size={24} /></span>
                <span className="tp-link-live-copy">
                  <span className="eyebrow">{t("setup.tpLinkLiveEyebrow")}</span>
                  <h2 id="tp-link-live-status-heading">{tpLinkStatusTitle}</h2>
                  <p>{t(integration.tpLink.connected ? "setup.tpLinkConnectedBody" : "setup.tpLinkConnectingBody")}</p>
                </span>
                <span className={`source-health-pill ${tpLinkHealthState}`} role="status"><span aria-hidden="true" />{tpLinkHealthLabel}</span>
              </header>

              {onOpenSensors && <div className="tp-link-live-next">
                <span><strong>{t("setup.tpLinkDeviceSummary", { mapped: integration.tpLink.mappedDevices, ready: tpLinkReadyDevices })}</strong><small>{t("setup.childFoundDetail")}</small></span>
                <button type="button" className="primary-button" onClick={onOpenSensors}><ThermometerSun size={16} aria-hidden="true" />{t("setup.childOpenSensors")}</button>
              </div>}

              {integration.tpLink.error && <div className={`tp-link-live-alert ${integration.tpLink.connected ? "warning" : "error"}`} role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t(integration.tpLink.connected ? "setup.tpLinkWarning" : "setup.tpLinkConnectionError")}</strong><small>{integration.tpLink.error}</small></span></div>}
              {(tpLinkDevicesError || tpLinkInventoryRefreshFailed) && <div className="tp-link-live-alert error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span><strong>{t("setup.tpLinkInventoryError")}</strong><small>{t("setup.tpLinkInventoryErrorDetail")}</small></span></div>}
              {(tpLinkDevicesLoading || refreshingTpLinkInventory) && <p className="tp-link-inventory-refresh" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("setup.tpLinkInventoryRefreshing")}</p>}

              {tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-busy={tpLinkChildDiscovery.phase === "settling"}>
                {tpLinkChildDiscovery.phase === "settling" && <>
                  <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                  <div className="child-discovery-progress" role="progressbar" aria-label={t("setup.childProgress", { attempt: tpLinkChildDiscovery.attempt, total: TP_LINK_CHILD_DISCOVERY_ATTEMPTS })} aria-valuemin={1} aria-valuemax={TP_LINK_CHILD_DISCOVERY_ATTEMPTS} aria-valuenow={tpLinkChildDiscovery.attempt}><span style={{ width: `${tpLinkChildDiscovery.attempt / TP_LINK_CHILD_DISCOVERY_ATTEMPTS * 100}%` }} /></div>
                </>}
                {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
                {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                  <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>
                </div>}
              </div>}

              <details className="setup-config-disclosure tp-link-detail-disclosure">
                <summary><span><Link2 size={16} aria-hidden="true" />{t("setup.tpLinkDetails")}</span><small>{t("setup.tpLinkDetailsSummary")}</small></summary>
                <div className="tp-link-detail-content">
                  <dl className="tp-link-live-metrics">
                    <div><dt>{t("setup.tpLinkSource")}</dt><dd>TP-Link {tpLinkHubName}</dd></div>
                    <div><dt>{t("setup.tpLinkLastPoll")}</dt><dd>{integration.tpLink.lastPollAt ? <time dateTime={integration.tpLink.lastPollAt}>{localDateTime(integration.tpLink.lastPollAt) ?? "—"}</time> : t("setup.tpLinkNoPoll")}</dd></div>
                    <div><dt>{t("setup.tpLinkDiscovered")}</dt><dd>{integration.tpLink.discoveredDevices}</dd></div>
                    <div><dt>{t("setup.tpLinkMapped")}</dt><dd>{integration.tpLink.mappedDevices}</dd></div>
                    <div><dt>{t("setup.tpLinkReady")}</dt><dd>{tpLinkReadyDevices}</dd></div>
                  </dl>
                  <div className="tp-link-polling-note">
                    <RadioTower size={17} aria-hidden="true" />
                    <span><strong>{streamStatusLabel}</strong><small>{t(`setup.streamHelp.${streamConnection}`)}</small></span>
                  </div>
                  <div className="tp-link-live-actions">
                    <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshingTpLinkInventory} onClick={() => void refreshTpLinkInventory()}>{tpLinkDevicesLoading || refreshingTpLinkInventory ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}{t("setup.tpLinkRefreshInventory")}</button>
                    <button type="button" className="secondary-button" disabled={testingDirect} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
                  </div>
                  {directResult && <p className={`test-result ${directResult}`} role={directResult === "failure" ? "alert" : "status"}>{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
                </div>
              </details>
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
              {tpLinkExportEnabled === true && <div className="tp-link-live-actions" aria-label={t("setup.tpLinkHistoryCanaryControls")}>
                <label className="field"><span>{t("setup.tpLinkHistoryCanarySensor")}</span><select aria-label={t("setup.tpLinkHistoryCanarySensor")} value={tpLinkCanarySensorId} disabled={tpLinkCanaryRunning || tpLinkCanaryTargets.length === 0} onChange={(event) => setTpLinkCanarySensorId(event.target.value)}>{tpLinkCanaryTargets.length === 0 ? <option value="">{t("setup.tpLinkHistoryNoMappedTarget")}</option> : tpLinkCanaryTargets.map((target) => <option key={target.sensorId} value={target.sensorId}>{target.label}</option>)}</select></label>
                <label className="field"><span>{t("common.metric")}</span><select aria-label={t("setup.tpLinkHistoryCanaryMetric")} value={tpLinkCanaryMetric} disabled={tpLinkCanaryRunning} onChange={(event) => setTpLinkCanaryMetric(event.target.value as "temperature" | "humidity")}><option value="temperature">{t("common.temperature")}</option><option value="humidity">{t("common.humidity")}</option></select></label>
                <button type="button" className="primary-button" disabled={tpLinkCanaryRunning || !tpLinkCanarySensorId} onClick={() => void runTpLinkCanary()}>{tpLinkCanaryRunning ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}{t("setup.tpLinkHistoryRunCanary")}</button>
              </div>}
              {tpLinkExportEnabled === true && <p className="setup-help">{t("setup.tpLinkHistoryCanaryHelp")}</p>}
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
                        {RETRYABLE_TP_LINK_EXPORT_STATUSES.has(job.status) && <button type="button" className="secondary-button" disabled={busyTpLinkExportJobId !== null} aria-label={t("setup.tpLinkHistoryRetryLabel", { device: deviceLabel })} onClick={() => void retryTpLinkExportJob(job)}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{t("setup.tpLinkHistoryRetry")}</button>}
                        {ACTIVE_TP_LINK_EXPORT_STATUSES.has(job.status) && <button type="button" className="danger-button" disabled={busyTpLinkExportJobId !== null} aria-label={t("setup.tpLinkHistoryCancelLabel", { device: deviceLabel })} onClick={() => void cancelTpLinkExportJob(job)}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("common.cancel")}</button>}
                        {!RETRYABLE_TP_LINK_EXPORT_STATUSES.has(job.status) && !ACTIVE_TP_LINK_EXPORT_STATUSES.has(job.status) && <small>{t("setup.tpLinkHistoryNoAction")}</small>}
                      </div></td>
                    </tr>;
                  })}</tbody>
                </table>
                </div>}
              </div>
            </details>}
            {activeSection === "connections" && <details className={`panel connection-card discovery-card ${sensorSourceConfigured ? "optional" : ""}`} aria-labelledby="network-discovery-heading" open={!sensorSourceConfigured || discovering || discoveryOutcome !== "idle"}>
              <summary className="connection-card-summary">
                <span className="connection-card-summary-copy"><span className="eyebrow">{t(sensorSourceConfigured ? "setup.addConnectionEyebrow" : "setup.scanTitle")}</span><strong id="network-discovery-heading">{t(sensorSourceConfigured ? "setup.addConnectionTitle" : "setup.scanDescription")}</strong><small>{t(sensorSourceConfigured ? "setup.addConnectionDescription" : "setup.scanScope")}</small></span>
                <span className="ha-mark" aria-hidden="true"><RadioTower size={22} /></span>
              </summary>
              <div className="discovery-card-content">
                <div className="connection-check guided-setup">
                <button type="button" className={`${sensorSourceConfigured ? "secondary-button" : "primary-button"} full-width`} disabled={discovering} onClick={() => void scanIntegrations()}>{discovering ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}{discovering ? t("setup.scanning") : t(sensorSourceConfigured ? "setup.findAdditionalSystems" : "setup.scan")}</button>
                <div className={`setup-discovery-feedback ${discovering ? "running" : discoveryOutcome}`} aria-live="polite" aria-busy={discovering}>
                  {discovering && <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.scanning")}</strong><small>{t("setup.scanProgress")}</small></span></p>}
                  {!discovering && discoveryOutcome === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.scanFound", { count: discoveredCount })}</strong><small>{t("setup.scanComplete")}</small></span></p>}
                  {!discovering && discoveryOutcome === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t(sensorSourceConfigured ? "setup.scanAdditionalEmpty" : "setup.scanEmpty")}</strong><small>{t(sensorSourceConfigured ? "setup.scanAdditionalEmptyDetail" : "setup.noDevices")}</small></span></p>}
                  {!discovering && discoveryOutcome === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.scanError")}</strong><small>{t("setup.scanPartial")}</small></span></p>}
                  {!discovering && discoveryOutcome === "found" && (discovery?.warnings.length ?? 0) > 0 && <p className="setup-discovery-partial"><TriangleAlert size={15} aria-hidden="true" />{t("setup.scanPartial")}</p>}
                  {!discovering && discovery && discovery.warnings.length > 0 && <ul className="setup-discovery-warnings">{discovery.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
                </div>
                </div>
              </div>
            </details>}
            {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="direct-connection-heading">
              <div className="panel-header"><div><span className="eyebrow">{t("setup.directTitle")}</span><h2 id="direct-connection-heading">{t("setup.directConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Router size={22} /></span></div>
              <p className="connection-card-description">{t("setup.directDescription")}</p>
              {discovery && discovery.tpLink.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectTpLink")}</legend>{discovery.tpLink.map((source) => <label key={source.host}><input type="radio" name="tp-link-discovery" value={source.host} checked={tpLinkHost === source.host} disabled={savingTpLink} onChange={() => changeTpLinkDraft("host", source.host)} /><span><strong>{source.alias ?? `TP-Link ${source.model}`}</strong><small>{t(source.sourceType === "energy-device" ? "setup.tpLinkEnergyDevice" : "setup.tpLinkHub")} · {source.model} · {source.host}</small></span></label>)}</fieldset>}
              <p className="setup-help setup-child-discovery-explainer">{t(integration.tpLink.configured ? "setup.tpLinkSettingsDescription" : "setup.childDiscoveryExplainer")}</p>
              {!integration.tpLink.configured && (discoveryOutcome === "error" || (discovery && discovery.tpLink.length === 0)) && <p className="setup-help setup-manual-fallback">{t("setup.tpLinkManualFallback")}</p>}
              <details className="setup-config-disclosure" open={tpLinkSettingsOpen} onToggle={(event) => setTpLinkSettingsOpen(event.currentTarget.open)}>
                <summary><span><Router size={16} aria-hidden="true" />{selectedDiscoveredTpLink ? selectedDiscoveredTpLink.alias ?? `TP-Link ${selectedDiscoveredTpLink.model}` : t(integration.tpLink.configured ? "setup.changeSavedTpLink" : "setup.manualConnection")}</span><small>{selectedDiscoveredTpLink ? `${selectedDiscoveredTpLink.model} · ${selectedDiscoveredTpLink.host}` : t(integration.tpLink.configured ? "setup.credentialsSavedShort" : "setup.manualHost")}</small></summary>
              {tpLinkSettingsOpen && <form className="connection-check guided-setup" onSubmit={(event) => void saveTpLink(event)}>
                {integration.tpLink.configured && <p className="configured-note"><Check size={17} aria-hidden="true" />{t("setup.configured")}</p>}
                <label className="field" htmlFor="tp-link-host"><span>{t("setup.host")}</span><input id="tp-link-host" type="text" value={tpLinkHost} maxLength={253} placeholder={t("setup.hostPlaceholder")} aria-describedby="tp-link-host-help" autoCapitalize="none" autoCorrect="off" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("host", event.target.value)} required /></label>
                <p className="setup-help" id="tp-link-host-help">{t("setup.hostHelp")}</p>
                <label className="field" htmlFor="tp-link-username"><span>{t("setup.username")}</span><input id="tp-link-username" type="email" value={tpLinkUsername} maxLength={320} aria-describedby="tp-link-username-help" autoComplete="username" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("username", event.target.value)} required /></label>
                <p className="setup-help" id="tp-link-username-help">{t("setup.usernameHelp")}</p>
                <label className="field" htmlFor="tp-link-password"><span>{t("setup.password")}</span><input id="tp-link-password" type={showTpLinkPassword ? "text" : "password"} value={tpLinkPassword} maxLength={4096} autoComplete="current-password" disabled={savingTpLink} onChange={(event) => changeTpLinkDraft("password", event.target.value)} required /></label>
                <label className="show-secret"><input type="checkbox" checked={showTpLinkPassword} onChange={(event) => setShowTpLinkPassword(event.target.checked)} /><span>{t("setup.showSecret")}</span></label>
                <p className="security-note"><LockKeyhole size={15} aria-hidden="true" />{t("setup.security")}</p>
                <button type="submit" className="primary-button full-width" disabled={savingTpLink || testingDirect}>{savingTpLink ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}{savingTpLink ? t("common.saving") : t("setup.saveConnect")}</button>
                {tpLinkFeedback && <p className={`test-result ${tpLinkFeedback.kind}`} role={tpLinkFeedback.kind === "error" ? "alert" : "status"}>{tpLinkFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{tpLinkFeedback.message}</p>}
                {!integration.tpLink.configured && tpLinkChildDiscovery.phase !== "idle" && <div className={`tp-link-child-discovery ${tpLinkChildDiscovery.phase}`} aria-live="polite" aria-busy={tpLinkChildDiscovery.phase === "settling"}>
                  {tpLinkChildDiscovery.phase === "settling" && <>
                    <p className="setup-discovery-message" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span><strong>{t("setup.childSettling", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</strong><small>{t("setup.childSettlingDetail", { hub: tpLinkChildDiscovery.hubModel ?? t("setup.tpLinkHub") })}</small></span></p>
                    <div className="child-discovery-progress" role="progressbar" aria-label={t("setup.childProgress", { attempt: tpLinkChildDiscovery.attempt, total: TP_LINK_CHILD_DISCOVERY_ATTEMPTS })} aria-valuemin={1} aria-valuemax={TP_LINK_CHILD_DISCOVERY_ATTEMPTS} aria-valuenow={tpLinkChildDiscovery.attempt}><span style={{ width: `${tpLinkChildDiscovery.attempt / TP_LINK_CHILD_DISCOVERY_ATTEMPTS * 100}%` }} /></div>
                  </>}
                  {tpLinkChildDiscovery.phase === "found" && <p className="setup-discovery-message" role="status"><Check size={18} aria-hidden="true" /><span><strong>{t("setup.childFound", { count: tpLinkChildDiscovery.count })}</strong><small>{t("setup.childFoundDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase === "empty" && <p className="setup-discovery-message" role="status"><CircleDot size={18} aria-hidden="true" /><span><strong>{t("setup.childEmpty")}</strong><small>{t("setup.childEmptyDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase === "error" && <p className="setup-discovery-message" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span><strong>{t("setup.childError")}</strong><small>{t("setup.childErrorDetail")}</small></span></p>}
                  {tpLinkChildDiscovery.phase !== "settling" && <div className="child-discovery-actions">
                    <button type="button" className="secondary-button" onClick={() => void settleTpLinkChildren(tpLinkChildDiscovery.hubModel)}><RefreshCw size={16} aria-hidden="true" />{t("setup.childRetry")}</button>
                    {onOpenSensors && <button type="button" className="primary-button" onClick={onOpenSensors}><ThermometerSun size={16} aria-hidden="true" />{t("setup.childOpenSensors")}</button>}
                  </div>}
                </div>}
                <button type="button" className="secondary-button full-width" disabled={testingDirect || savingTpLink} onClick={() => void testDirectConnection()}>{testingDirect ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Router size={16} aria-hidden="true" />}{testingDirect ? t("setup.scanning") : t("setup.testDirect")}</button>
                {directResult && <p className={`test-result ${directResult}`} role={directResult === "failure" ? "alert" : "status"}>{directResult === "success" ? <ShieldCheck size={17} aria-hidden="true" /> : <CircleDot size={17} aria-hidden="true" />}{directResult === "success" ? t("setup.directTestSuccess") : t("setup.directTestFailure")}</p>}
                <details className="advanced-setup"><summary>{t("setup.advanced")}</summary><pre className="env-example" aria-label={t("setup.directEnvironmentVariables")}><code>TP_LINK_HOST=192.0.2.10{"\n"}TP_LINK_USERNAME=user@example.com{"\n"}TP_LINK_PASSWORD=••••••••</code></pre></details>
              </form>}
              </details>
            </section>}
            {activeSection === "connections" && <section className="panel connection-card" aria-labelledby="connection-heading">
              <div className="panel-header"><div><span className="eyebrow">Home Assistant</span><h2 id="connection-heading">{t("setup.homeAssistantConnectionTitle")}</h2></div><span className="ha-mark" aria-hidden="true"><Home size={22} /></span></div>
              <p className="connection-card-description">{t("setup.homeAssistantConnectionDescription")}</p>
              {discovery && discovery.homeAssistant.length > 0 && <fieldset className="discovery-results setup-found-results"><legend>{t("setup.selectHomeAssistant")}</legend>{discovery.homeAssistant.map((instance) => <label key={instance.url}><input type="radio" name="home-assistant-discovery" value={instance.url} checked={haUrl === instance.url} disabled={savingHomeAssistant} onChange={() => changeHomeAssistantDraft("url", instance.url)} /><span><strong>{instance.name}</strong><small>{instance.url}{instance.version ? ` · ${instance.version}` : ""}</small></span></label>)}</fieldset>}
              <details className="setup-config-disclosure">
                <summary><span><Home size={16} aria-hidden="true" />{selectedDiscoveredHomeAssistant?.name ?? t("setup.manualConnection")}</span><small>{selectedDiscoveredHomeAssistant ? selectedDiscoveredHomeAssistant.url : t("setup.manualService")}</small></summary>
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
              </details>
            </section>}
            {activeSection === "connections" && <details className="panel connection-assignment-manager" aria-labelledby="connection-assignment-title">
              <summary className="connection-manager-summary">
                <span className="ha-mark" aria-hidden="true"><Link2 size={22} /></span>
                <span className="connection-manager-summary-copy"><span className="eyebrow">{t("setup.connectionManagerEyebrow")}</span><strong id="connection-assignment-title">{t("setup.connectionManagerTitle")}</strong><small>{t("setup.connectionManagerCount", { count: assignmentCount })}</small></span>
              </summary>
              <div className="connection-assignment-content">
                <p className="setup-help">{t("setup.connectionManagerBody")}</p>
                {assignmentCount === 0
                  ? <p className="connection-assignment-empty">{t("setup.noConnectionAssignments")}</p>
                  : <div className="connection-assignment-list">
                    {homeAssistantAssignments.map((assignment) => {
                      const assignedHouse = connectionHouses.find((candidate) => candidate.id === assignment.houseId);
                      const key = `ha:${assignment.houseId}`;
                      const targetHouseId = assignmentHouseDrafts[key] ?? assignment.houseId;
                      const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                      const sourceName = "Home Assistant";
                      return <article key={key} className="connection-assignment-row">
                        <span className={`status-symbol ${assignment.connected ? "positive" : ""}`} aria-hidden="true"><Home size={17} /></span>
                        <span><strong>Home Assistant</strong><small>{t("setup.assignedToHome", { home: assignedHouse?.name ?? assignment.houseId })}</small></span>
                        <label className="connection-assignment-home">
                          <span>{t("setup.assignedHome")}</span>
                          <select value={targetHouseId} disabled={busyAssignment !== null} aria-label={t("setup.assignedHomeFor", { source: sourceName })} onChange={(event) => setAssignmentHouseDrafts((current) => ({ ...current, [key]: event.target.value }))}>
                            {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={candidate.id !== assignment.houseId && homeAssistantAssignments.some((current) => current.houseId === candidate.id)}>{candidate.name}</option>)}
                          </select>
                        </label>
                        <div className="connection-assignment-actions">
                          <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === assignment.houseId} aria-label={t("setup.moveHomeAssistantLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => void moveHomeAssistantAssignment(assignment.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                          <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectHomeAssistantLabel", { home: assignedHouse?.name ?? assignment.houseId })} onClick={() => void disconnectHomeAssistantAssignment(assignment.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                        </div>
                      </article>;
                    })}
                    {tpLinkAssignments.map((assignment) => {
                      const assignedHouse = connectionHouses.find((candidate) => candidate.id === assignment.houseId);
                      const key = `tp:${assignment.id}`;
                      const targetHouseId = assignmentHouseDrafts[key] ?? assignment.houseId;
                      const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                      const sourceName = `TP-Link ${assignment.hubModel ?? t("setup.tpLinkDefault")}`;
                      return <article key={key} className="connection-assignment-row">
                        <span className={`status-symbol ${assignment.connected ? "positive" : ""}`} aria-hidden="true"><Router size={17} /></span>
                        <span><strong>{sourceName}</strong><small>{t(assignment.connected ? "common.connected" : "common.notConnected")}</small></span>
                        <label className="connection-assignment-home">
                          <span>{t("setup.assignedHome")}</span>
                          <select value={targetHouseId} disabled={busyAssignment !== null} aria-label={t("setup.assignedHomeFor", { source: sourceName })} onChange={(event) => setAssignmentHouseDrafts((current) => ({ ...current, [key]: event.target.value }))}>
                            {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                          </select>
                        </label>
                        <div className="connection-assignment-actions">
                          <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === assignment.houseId} aria-label={t("setup.moveTpLinkLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => void moveTpLinkAssignment(assignment.id, assignment.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                          <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectTpLinkLabel", { home: assignedHouse?.name ?? assignment.houseId })} onClick={() => void disconnectTpLinkAssignment(assignment.id, assignment.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                        </div>
                      </article>;
                    })}
                  </div>}
                {assignmentFeedback && <p className={`test-result ${assignmentFeedback.kind}`} role={assignmentFeedback.kind === "error" ? "alert" : "status"}>{assignmentFeedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{assignmentFeedback.message}</p>}
              </div>
            </details>}
            {activeSection === "overview" && <section className="panel integration-status" aria-label={t("status.dataSource")}>
              <div><span className={`status-symbol ${integration.tpLink.connected ? "positive" : ""}`}><Router size={17} aria-hidden="true" /></span><span><strong>TP-Link {integration.tpLink.hubModel ?? (integration.tpLink.connected ? t("setup.tpLinkEnergyDevice") : t("setup.tpLinkDefault"))}</strong><small>{integration.tpLink.lastPollAt ? t("setup.lastPoll", { time: localDateTime(integration.tpLink.lastPollAt) ?? "—" }) : t("setup.mappedDevices", { count: integration.tpLink.mappedDevices })}</small></span><b>{integration.tpLink.connected ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.homeAssistant.connected ? "positive" : ""}`}><Home size={17} aria-hidden="true" /></span><span><strong>Home Assistant</strong><small>{t("setup.mapped", { count: integration.homeAssistant.mappedEntities })}</small></span><b>{integration.homeAssistant.connected ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.mock.enabled ? "positive" : ""}`}><RadioTower size={17} aria-hidden="true" /></span><span><strong>{integration.mock.mode === "real" ? t("setup.mockLocked") : t("setup.mockEnabled")}</strong><small>{integration.mock.mode === "real" ? t("setup.realDataMode") : `${integration.mock.intervalMs / 1000}s`}</small></span><b>{integration.mock.enabled ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.webhook.configured ? "positive" : ""}`}><ExternalLink size={17} aria-hidden="true" /></span><span><strong>DayOps / OpenWearable webhook</strong><small>{integration.webhook.lastDeliveryAt ? t("setup.lastEvent", { time: localDateTime(integration.webhook.lastDeliveryAt) ?? "—" }) : t("common.noData")}</small></span><b>{integration.webhook.configured ? t("common.on") : t("common.off")}</b></div>
              <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? (integration.weather.lastSuccessAt ? t("weather.lastSuccess", { time: localDateTime(integration.weather.lastSuccessAt) ?? "—" }) : t("weather.configuredHouses", { count: integration.weather.configuredHouses }))}</small></span><b>{t("setup.automatic")}</b></div>
            </section>}
          </div>
        </div>}

        {(activeSection === "homes" || activeSection === "weather") && <section
          id={`setup-panel-${activeSection}`}
          className={`weather-section setup-workspace-panel ${activeSection}-workspace`}
          role="tabpanel"
          aria-labelledby={`setup-tab-${activeSection}`}
        >
          <header className="weather-heading">
            <div><span className="eyebrow">{activeSection === "homes" ? <Building2 size={14} aria-hidden="true" /> : <CloudSun size={14} aria-hidden="true" />}{activeSection === "homes" ? t("setup.workspaceHomes") : t("setup.workspaceWeather")}</span><h2>{activeSection === "homes" ? t("placement.title") : t("setup.weatherConfigurationTitle")}</h2><p>{activeSection === "homes" ? t("setup.homesDescription") : t("setup.weatherConfigurationDescription", { house: house.name })}</p></div>
            <div className="weather-heading-actions">
              <label className="weather-house-picker"><span>{t("common.house")}</span><select value={house.id} onChange={(event) => selectSetupHouse(event.target.value)}>{houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
              <span className={`weather-freshness ${activeSection === "homes" ? (house.mapPlacement ? "fresh" : "stale") : (house.location ? "fresh" : "stale")}`}>{activeSection === "homes" ? (house.mapPlacement ? <Check size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />) : (house.location ? <Check size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />)}{activeSection === "homes" ? (house.mapPlacement ? t("placement.scaled") : t("placement.unplaced")) : (house.location ? t("weather.locationSet") : t("weather.locationMissing"))}</span>
            </div>
          </header>

          <div className="weather-location-grid">
            {activeSection === "homes" && <section className="panel weather-location-card" aria-labelledby="weather-location-title">
              <div className="panel-header"><div><span className="eyebrow">{t("placement.eyebrow", { count: houses.length })}</span><h3 id="weather-location-title">{t("placement.title")}</h3></div><span className="weather-card-icon"><Building2 size={20} aria-hidden="true" /></span></div>
              <p className="weather-card-description">{t("placement.description")}</p>
              <div className="house-map-toolbar">
                <div className="house-map-house-list" role="group" aria-label={t("placement.houseList")}>
                  {houses.map((candidate) => (
                    <button key={candidate.id} type="button" className={candidate.id === house.id ? "active" : ""} aria-pressed={candidate.id === house.id} onClick={() => selectSetupHouse(candidate.id)}>
                      <Building2 size={14} aria-hidden="true" />
                      <span><strong>{candidate.name}</strong><small>{candidate.mapPlacement ? t("placement.scaled") : candidate.location ? t("placement.pinOnly") : t("placement.unplaced")}</small></span>
                    </button>
                  ))}
                </div>
                <div className="house-map-view-actions" role="group" aria-label={t("placement.mapView")}>
                  <button type="button" className={mapViewport === "all" ? "active" : ""} aria-pressed={mapViewport === "all"} onClick={() => setMapViewport("all")}><Maximize2 size={14} aria-hidden="true" />{t("placement.showAll")}</button>
                  <button type="button" className={mapViewport === "selected" ? "active" : ""} aria-pressed={mapViewport === "selected"} disabled={!draftMapLocation} onClick={() => setMapViewport("selected")}><LocateFixed size={14} aria-hidden="true" />{t("placement.centerSelected")}</button>
                </div>
              </div>
              {!mapLoaded ? <div className="setup-map-gate">
                <MapPin size={28} aria-hidden="true" />
                <div><strong>{t("setup.loadMapTitle")}</strong><p>{t("setup.loadMapDescription")}</p></div>
                <button type="button" className="primary-button" onClick={() => setMapLoaded(true)}><MapPin size={16} aria-hidden="true" />{t("setup.loadMap")}</button>
              </div> : <>
                <Suspense fallback={<output className="setup-map-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("common.loading")}</output>}>
                  <div className={`house-map-shell ${placementEditing ? "editing" : ""}`}>
                    <HouseLocationMap
                      items={mapItems}
                      selectedHouseId={house.id}
                      editable={placementEditing}
                      onSelect={selectSetupHouse}
                      onChange={updateFromMap}
                      ariaLabel={t("placement.mapLabel")}
                      viewport={mapViewport}
                    />
                    {placementEditing && <p className="house-map-editing-cue"><Move size={14} aria-hidden="true" />{t("placement.editingHint", { house: house.name })}</p>}
                  </div>
                </Suspense>
                <p className="weather-map-hint">{t("placement.mapHint")}</p>
              </>}
              <details className="setup-config-disclosure home-placement-advanced">
                <summary><span><Ruler size={15} aria-hidden="true" />{t("setup.advancedPlacement")}</span><small>{t("setup.manualCoordinates")}</small></summary>
              <div className="house-placement-fields">
                <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={placementLatitude} onChange={(event) => { setPlacementLatitude(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></label>
                <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={placementLongitude} onChange={(event) => { setPlacementLongitude(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></label>
                {house.floors.length > 0 && <label className="field"><span>{t("placement.footprintFloor")}</span><select value={selectedFootprintFloor?.id ?? ""} onChange={(event) => { setFootprintFloorId(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }}>{house.floors.filter((floor) => floor.type !== "outdoor").map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select></label>}
                <label className="field"><span>{t("placement.widthMeters")}</span><span className="input-with-icon"><Ruler size={15} aria-hidden="true" /><input type="number" min={1} max={500} step="0.1" inputMode="decimal" value={footprintWidthMeters} onChange={(event) => { setFootprintWidthMeters(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} required /></span>{footprintDepthMeters !== null && <small>{t("placement.depthEstimate", { depth: decimal(footprintDepthMeters, locale, 1) })}</small>}</label>
              </div>
              <fieldset className="house-orientation-fieldset">
                <legend><Compass size={15} aria-hidden="true" />{t("orientation.title")}</legend>
                <p>{t("orientation.description")}</p>
                <div className="house-orientation-inputs">
                  <label className="field"><span>{t("orientation.degrees")}</span><input type="number" min={0} max={359} step={1} inputMode="numeric" value={orientation} placeholder={t("orientation.unknown")} onChange={(event) => { setOrientation(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} /></label>
                  <label className="house-orientation-range"><span>{t("orientation.rotate")}</span><input type="range" min={0} max={359} step={1} value={draftOrientation ?? 0} onChange={(event) => { setOrientation(event.target.value); setPlacementEditing(true); setPlacementFeedback(null); }} /></label>
                </div>
                <div className="house-orientation-presets" role="group" aria-label={t("orientation.presets")}>
                  {([[0, "N"], [90, "E"], [180, "S"], [270, "W"]] as const).map(([degrees, label]) => <button key={degrees} type="button" className={draftOrientation === degrees ? "active" : ""} aria-pressed={draftOrientation === degrees} onClick={() => { setOrientation(String(degrees)); setPlacementEditing(true); setPlacementFeedback(null); }}>{label}<small>{degrees}{"\u00b0"}</small></button>)}
                </div>
                <p className="house-orientation-explanation" role="status" aria-live="polite"><Compass size={15} aria-hidden="true" /><span>{orientationExplanation}</span></p>
                {house.orientationDegrees !== undefined && <button type="button" className="text-button" disabled={savingPlacement} onClick={() => void clearOrientation()}>{t("orientation.clear")}</button>}
              </fieldset>
              </details>
              <div className="house-placement-actions">
                {!placementEditing && <button type="button" className="primary-button" onClick={() => { setPlacementEditing(true); setPlacementFeedback(null); }}><Move size={16} aria-hidden="true" />{house.mapPlacement ? t("placement.move") : t("placement.place")}</button>}
                {placementEditing && <><button type="button" className="primary-button" disabled={savingPlacement || !draftPlacement} onClick={() => void savePlacement()}>{savingPlacement ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{savingPlacement ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={savingPlacement} onClick={resetPlacementDraft}>{t("common.cancel")}</button></>}
                {house.mapPlacement && <button type="button" className="secondary-button danger-text" disabled={savingPlacement} onClick={() => void removePlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
              </div>
              {placementFeedback && <p className={`weather-feedback ${placementFeedback.kind}`} role={placementFeedback.kind === "error" ? "alert" : "status"}>{placementFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{placementFeedback.message}</p>}
            </section>}

            {activeSection === "weather" && <section className="panel setup-weather-config-card" aria-labelledby="weather-reference-title">
              <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h3 id="weather-reference-title">{t("placement.weatherReference")}</h3></div><span className="weather-card-icon"><CloudSun size={20} aria-hidden="true" /></span></div>
              <p className="weather-card-description">{t("placement.weatherDescription")}</p>
              <LocationDiscoveryPanel key={house.id} {...(house.location ? { currentLocation: house.location } : {})} currentTimezone={house.timezone} onApply={applyDiscoveredDefaults} />
              <div className="setup-config-summary">
                <div><span>{t("setup.provider")}</span><strong>{t("setup.weatherService")}</strong><small>{t("setup.providerAutomatic")}</small></div>
                <div><span>{t("setup.timezone")}</span><strong>{house.timezone}</strong><small>{t("setup.timezoneManaged")}</small></div>
                <div><span>{t("placement.weatherReference")}</span><strong>{house.location?.label ?? (house.location ? `${decimal(house.location.latitude, locale, 4)}, ${decimal(house.location.longitude, locale, 4)}` : t("weather.locationMissing"))}</strong><small>{house.location ? t("weather.locationSet") : t("setup.weatherNeeded")}</small></div>
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
                  {house.location && <button type="button" className="secondary-button" disabled={savingLocation} onClick={() => void removeLocation()}><Trash2 size={16} aria-hidden="true" />{t("weather.removeLocation")}</button>}
                </div>
              </details>
              {locationFeedback && <p className={`weather-feedback ${locationFeedback.kind}`} role={locationFeedback.kind === "error" ? "alert" : "status"}>{locationFeedback.kind === "success" ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{locationFeedback.message}</p>}
            </section>}

            {activeSection === "weather" && <section className="panel setup-system-card" aria-labelledby="setup-system-title">
              <div className="panel-header"><div><span className="eyebrow">{t("setup.systemEyebrow")}</span><h3 id="setup-system-title">{t("setup.systemTitle")}</h3></div><span className="weather-card-icon current"><RadioTower size={20} aria-hidden="true" /></span></div>
              <p className="weather-card-description">{t("setup.systemDescription")}</p>
              <div className="integration-status compact-status">
                <div><span className={`status-symbol ${integration.weather.configuredHouses > 0 && !integration.weather.error ? "positive" : ""}`}><CloudSun size={17} aria-hidden="true" /></span><span><strong>{t("setup.weatherService")}</strong><small>{integration.weather.error ?? t("weather.configuredHouses", { count: integration.weather.configuredHouses })}</small></span><b>{t("setup.automatic")}</b></div>
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
            <div className="panel-header"><div><span className="eyebrow">{house.name}</span><h2>{t("setup.layoutTitle")}</h2></div><Building2 size={22} aria-hidden="true" /></div>
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
          <SetupOperationsPanel house={house} />
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