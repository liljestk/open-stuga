import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  Edit3,
  FileSpreadsheet,
  Home,
  LoaderCircle,
  MapPin,
  Plus,
  Printer,
  QrCode,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  ThermometerSun,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  Floor,
  House,
  IntegrationStatus,
  MeasurementSample,
  Metric,
  Sensor,
  SensorLabelDescriptor,
  TpLinkDiscoveredDevice,
  UnitSystem,
} from "@climate-twin/contracts";
import { api, type CreateSensorInput, type HistoricalImportResult, type SensorPatch } from "../../api";
import type { ClimateState, TimeRange } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { formatInTimeZone } from "../../dateTime";
import { measurementLabel } from "../../measurements";
import { useNow } from "../../useNow";
import { integrationForHouse } from "../../integrationScope";
import { assessSensorCoverage, suggestSensorPlacement, type SensorCoverageAssessment, type SensorPlacementSuggestion } from "../../experimentalSpatialLayers";
import { configuredSpatialMaxSampleAgeMs } from "../../spatialFreshness";
import { useSpatialLayers } from "../../useSpatialLayers";
import { qrCodeMatrix } from "../../qrCode";
import { TrendChart } from "../../components/TrendChart";
import { HistoricalImportWizard, PlacementPicker, SensorLabelCard, UNPLACED_TAG, availableForSensor, clamp, deviceBindingKey, draftContext, draftForSensor, errorMessage, hasHomeAssistantBinding, hasRealBinding, initialDraft, isDemoSensor, isLive, isUnplaced, latestSensorTimestamp, mergeMetricSamples, normalizedMeasurementEntityIds, roomCenter, rounded, sameMeasurementEntityIds, sensorFloor, sensorHasMetric, sensorMeasurementEntityIds, sensorStatus, stableRoomId, tpLinkDeviceSummary, validationErrors } from "./support";
import type { AddStep, DraftErrors, DraftSource, EditorMode, Feedback, SensorDraft, SensorFilter, SensorManagementPageProps, SensorStatus, Translate } from "./support";
import { useSensorManagementPagePart04 } from "./part-04";
export function renderSensorManagementPage(context: ReturnType<typeof useSensorManagementPagePart04>) {
  const { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData, locale, t, now, tpLinkStatus, formId, pageHeadingRef, editorHeadingRef, editorOpenerRef, importButtonRef, detailsHeadingRef, detailsOpenerRef, detailsRequestGeneration, search, setSearch, filter, setFilter, mode, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, attachSensorId, setAttachSensorId, draft, setDraft, errors, setErrors, editorFeedback, setEditorFeedback, pageFeedback, setPageFeedback, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, refreshError, setRefreshError, importOpen, setImportOpen, detailsSensor, setDetailsSensor, detailSamples, setDetailSamples, detailCursor, setDetailCursor, detailsLoading, setDetailsLoading, detailsError, setDetailsError, detailMetric, setDetailMetric, detailRange, setDetailRange, currentSensors, currentSensorIds, visibleDetailsSensor, demoSensors, hasExistingRealBoundSensor, enabledMeasurementDefinitions, detailDefinitions, detailDefinition, detailHistory, usedDeviceIds, homeTpLinkDevices, addableDevices, attachableSensors, sensorStatuses, statusCounts, normalizedSearch, visibleSensors, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, draftDevice, energyOnlyDraft, placementAnalysisEnabled, placementLayerScope, placementLayers, placementCoverage, placementSuggestion, clearError, beginAdd, beginEdit, restoreEditorFocus, cancelEditor, closeImport, loadSensorDetails, closeSensorDetails, chooseSource, chooseDevice, attachDeviceToExistingSensor, changeDraftHouse, changeDraftFloor, focusFirstError, advanceAdd, retreatAdd, buildPlacement, submitAdd, submitEdit, setArchived, removeSensor, removeDemoSensors, refreshDevices, renderFieldError, fieldA11y, renderDetailsFields, renderBindingField, renderHomeAssistantBindings, renderLocationFields, renderAddEditor, renderEditEditor } = context;
  return (
      <>
        <header className="page-heading sensor-page-heading">
          <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{t("sensors.eyebrow")}</span><h1 ref={pageHeadingRef} tabIndex={-1}>{t("sensors.title")}</h1><p>{t("sensors.description")}</p></div>
          {!readOnly && (currentSensors.length > 0 || demoSensors.length > 0) && <div className="sensor-heading-actions">
            {demoSensors.length > 0 && <button type="button" className="secondary-button delete-action" onClick={() => void removeDemoSensors()} disabled={mode !== "closed" || cleanupBusy}>{cleanupBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{cleanupBusy ? t("sensors.removingDemoSensors") : t("sensors.removeDemoSensors", { count: demoSensors.length })}</button>}
            {currentSensors.length > 0 && <button type="button" className="primary-button" onClick={beginAdd} disabled={mode !== "closed" || cleanupBusy}><Plus size={16} aria-hidden="true" />{t("sensors.add")}</button>}
          </div>}
        </header>

        {!readOnly && localAuthority && importOpen && <Suspense fallback={<output className="history-import-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" />{t("common.loading")}</output>}>
          <HistoricalImportWizard
            open
            house={house}
            sensors={currentSensors}
            definitions={state.measurementDefinitions.filter((definition) => definition.enabled)}
            onClose={closeImport}
            onImport={onImportHistoricalData}
          />
        </Suspense>}

        {pageFeedback && <p className={`sensor-page-feedback ${pageFeedback.kind}`} role={pageFeedback.kind === "error" ? "alert" : "status"}>{pageFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{pageFeedback.message}<button type="button" className="icon-button small" onClick={() => setPageFeedback(null)} aria-label={t("common.close")}><X size={14} /></button></p>}

        {!readOnly && localAuthority && tpLinkStatus.configured && <section
          className={`sensor-discovery-watch ${tpLinkStatus.connected ? "active" : "waiting"}`}
          role="region"
          aria-label={t("sensors.discoveryStatus")}
        >
          <span className="sensor-discovery-watch-icon" aria-hidden="true">
            {tpLinkDevicesLoading || refreshing
              ? <LoaderCircle className="spin" size={19} />
              : tpLinkStatus.connected
                ? <RadioTower size={19} />
                : <RefreshCw className="spin" size={19} />}
          </span>
          <span>
            <strong>{t(tpLinkStatus.connected ? "sensors.discoveryWatchingTitle" : "sensors.discoveryPausedTitle")}</strong>
            <small>{tpLinkStatus.connected
              ? tpLinkStatus.lastPollAt
                ? t("sensors.discoveryLastChecked", { time: formatInTimeZone(tpLinkStatus.lastPollAt, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
                : t("sensors.discoveryStarting")
              : t("sensors.discoveryPaused")}</small>
          </span>
          <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}>
            <RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDeviceList")}
          </button>
        </section>}

        <section className="sensor-overview" aria-label={t("sensors.overview") }>
          <button type="button" className={filter === "waiting" ? "active" : ""} aria-pressed={filter === "waiting"} onClick={() => setFilter("waiting")}><span className="sensor-overview-icon waiting"><TriangleAlert size={18} aria-hidden="true" /></span><span><small>{t("sensors.waiting")}</small><strong>{statusCounts.waiting}</strong></span></button>
          <button type="button" className={filter === "unplaced" ? "active" : ""} aria-pressed={filter === "unplaced"} onClick={() => setFilter("unplaced")}><span className="sensor-overview-icon unplaced"><MapPin size={18} aria-hidden="true" /></span><span><small>{t("sensors.unplaced")}</small><strong>{statusCounts.unplaced}</strong></span></button>
          <button type="button" className={filter === "live" ? "active" : ""} aria-pressed={filter === "live"} onClick={() => setFilter("live")}><span className="sensor-overview-icon live"><CircleDot size={18} aria-hidden="true" /></span><span><small>{t("sensors.live")}</small><strong>{statusCounts.live}</strong></span></button>
          <button type="button" className={filter === "archived" ? "active" : ""} aria-pressed={filter === "archived"} onClick={() => setFilter("archived")}><span className="sensor-overview-icon archived"><Archive size={18} aria-hidden="true" /></span><span><small>{t("sensors.archived")}</small><strong>{statusCounts.archived}</strong></span></button>
        </section>

        {!readOnly && mode === "add" && renderAddEditor()}
        {!readOnly && mode === "edit" && renderEditEditor()}

        {visibleDetailsSensor && <section id="sensor-details-panel" className="panel sensor-details-panel" aria-labelledby="sensor-details-title">
          <header>
            <div><span className="eyebrow">{t("sensors.dataAndLogs")}</span><h2 ref={detailsHeadingRef} id="sensor-details-title" tabIndex={-1}>{visibleDetailsSensor.name}</h2><small>{visibleDetailsSensor.id}</small></div>
            <button type="button" className="icon-button" onClick={closeSensorDetails} aria-label={t("common.close")}><X size={17} /></button>
          </header>
          <div className="sensor-details-summary">
            <span><Database size={15} aria-hidden="true" />{t("sensors.loadedRecords", { count: detailSamples.length })}</span>
            <small>{t("sensors.newestFirst")}</small>
          </div>
          {detailDefinition && <div className="sensor-detail-visualization">
            <div className="sensor-detail-visualization-toolbar">
              <span><strong>{t("sensors.visualization")}</strong><small>{t("sensors.visualizationDescription")}</small></span>
              <label className="field"><span>{t("sensors.analyticsMetric")}</span><select value={detailDefinition.id} onChange={(event) => setDetailMetric(event.target.value)}>{detailDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{measurementLabel(definition, locale)}</option>)}</select></label>
            </div>
            <TrendChart
              sensor={visibleDetailsSensor}
              history={detailHistory}
              forecast={state.measurementForecasts[visibleDetailsSensor.id]?.[detailDefinition.id] ?? []}
              definition={detailDefinition}
              units={units}
              range={detailRange}
              onRange={setDetailRange}
              timeZone={house.timezone}
              heading={measurementLabel(detailDefinition, locale)}
            />
          </div>}
          <SensorLabelCard sensor={visibleDetailsSensor} />
          {detailsError && <p className="sensor-details-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{detailsError}</p>}
          {detailSamples.length > 0 ? <div className="sensor-log-scroll" role="region" aria-labelledby="sensor-details-title" tabIndex={0}><table>
            <thead><tr><th>{t("sensors.logTime")}</th><th>{t("sensors.logMetric")}</th><th>{t("sensors.logValue")}</th><th>{t("sensors.logSource")}</th><th>{t("sensors.logQuality")}</th></tr></thead>
            <tbody>{detailSamples.map((sample, index) => <tr key={`${sample.timestamp}-${sample.metric}-${sample.source}-${index}`}>
              <td>{formatInTimeZone(Date.parse(sample.timestamp), locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })}</td>
              <td>{state.measurementDefinitions.find((definition) => definition.id === sample.metric)
                ? measurementLabel(state.measurementDefinitions.find((definition) => definition.id === sample.metric)!, locale)
                : sample.metric}</td>
              <td>{sample.value} {sample.canonicalUnit}</td><td>{sample.source}</td><td>{sample.quality}</td>
            </tr>)}</tbody>
          </table></div> : !detailsLoading && !detailsError ? <p className="sensor-details-empty">{t("sensors.noData")}</p> : null}
          <footer>
            {detailsLoading && <span role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.loadingData")}</span>}
            {!detailsLoading && detailCursor && <button type="button" className="secondary-button" onClick={() => void loadSensorDetails(visibleDetailsSensor, detailCursor)}>{t("sensors.loadMore")}</button>}
            {!readOnly && <div className="sensor-details-actions">
              <button type="button" className="secondary-button" disabled={mode !== "closed" || cleanupBusy} onClick={() => { beginEdit(visibleDetailsSensor); closeSensorDetails(); }}><Edit3 size={14} aria-hidden="true" />{t("sensors.editAction", { name: visibleDetailsSensor.name })}</button>
              <button type="button" className="secondary-button archive-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void setArchived(visibleDetailsSensor, visibleDetailsSensor.enabled)}>{rowBusyId === visibleDetailsSensor.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : visibleDetailsSensor.enabled ? <Archive size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}{visibleDetailsSensor.enabled ? t("sensors.archiveAction", { name: visibleDetailsSensor.name }) : t("sensors.restoreAction", { name: visibleDetailsSensor.name })}</button>
              <button type="button" className="secondary-button delete-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void removeSensor(visibleDetailsSensor)}><Trash2 size={14} aria-hidden="true" />{t("sensors.deleteAction", { name: visibleDetailsSensor.name })}</button>
            </div>}
          </footer>
        </section>}

        <div className="sensor-workspace">
          {currentSensors.length === 0 ? <section className="panel sensor-help-card" aria-labelledby="sensor-zero-title">
            <span className="sensor-help-icon"><ThermometerSun size={20} aria-hidden="true" /></span>
            <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-zero-title">{t("sensors.easySetup")}</h2><p>{t("sensors.easySetupHelp")}</p>{!readOnly && mode === "closed" && <button type="button" className="primary-button" onClick={beginAdd}><Plus size={15} aria-hidden="true" />{t("sensors.startSetup")}</button>}</div>
          </section> : <section className="panel sensor-list-panel" aria-labelledby="sensor-list-title">
            <div className="sensor-list-header">
              <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-list-title">{t("sensors.houseSensors", { house: house.name })}</h2></div>
            </div>
            <div className="sensor-list-controls">
              <label className="field sensor-search-field"><span>{t("sensors.search")}</span><span className="sensor-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("sensors.searchPlaceholder")} /></span></label>
              <label className="field sensor-filter"><span>{t("sensors.filter")}</span><select value={filter} onChange={(event) => setFilter(event.target.value as SensorFilter)}><option value="all">{t("sensors.filterAll")}</option><option value="live">{t("sensors.filterLive")}</option><option value="waiting">{t("sensors.filterWaiting")}</option><option value="unplaced">{t("sensors.filterUnplaced")}</option><option value="archived">{t("sensors.filterArchived")}</option></select></label>
            </div>
            {visibleSensors.length > 0 ? (
              <ul className="sensor-inventory-list">
                {visibleSensors.map((sensor) => {
                  const floor = sensorFloor(sensor, houses);
                  const status = sensorStatuses.get(sensor.id) ?? "waiting";
                  const lastTimestamp = latestSensorTimestamp(state, sensor.id);
                  const sensorTimeZone = houses.find((candidate) => candidate.id === sensor.houseId)?.timezone;
                  return (
                    <li key={sensor.id} className={!sensor.enabled ? "archived" : ""}>
                      <span className="sensor-list-glyph" aria-hidden="true"><span /><span /></span>
                      <div className="sensor-list-copy">
                        <span className="sensor-list-name"><strong>{sensor.name}</strong>{isDemoSensor(sensor) && <span className="sensor-demo-badge">{t("sensors.demoBadge")}</span>}<span className={`sensor-status-badge ${status}`}>{t(`sensors.${status}`)}</span></span>
                        <span className="sensor-list-location"><Home size={13} aria-hidden="true" />{sensor.room} · {floor?.name ?? t("sensors.unknownFloor")}</span>
                        <small>{sensor.model}{sensor.tpLinkDeviceId ? ` · ${t("sensors.boundTo", { id: sensor.tpLinkDeviceId })}` : ` · ${t("sensors.manual")}`}{lastTimestamp ? ` · ${t("sensors.lastSeen", { time: formatInTimeZone(lastTimestamp, locale, sensorTimeZone, { dateStyle: "short", timeStyle: "short" }) })}` : ""}</small>
                      </div>
                      <div className="sensor-list-actions">
                        <button type="button" className="secondary-button" disabled={cleanupBusy} aria-expanded={visibleDetailsSensor?.id === sensor.id} aria-controls="sensor-details-panel" onClick={() => void loadSensorDetails(sensor)}><Database size={14} aria-hidden="true" />{t("sensors.detailsAction", { name: sensor.name })}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <div className="sensor-list-empty"><Search size={22} aria-hidden="true" /><strong>{t("sensors.noMatches")}</strong><p>{t("sensors.noMatchesHelp")}</p></div>}
          </section>}

          {!readOnly && localAuthority && <aside className="sensor-side-column">
            {currentSensors.length > 0 && <details className="panel sensor-import-card">
              <summary><span><FileSpreadsheet size={16} aria-hidden="true" /><strong>{t("historyImport.open")}</strong></span><ChevronDown size={16} aria-hidden="true" /></summary>
              <button ref={importButtonRef} type="button" className="secondary-button full-width" disabled={mode !== "closed"} onClick={() => setImportOpen(true)}><FileSpreadsheet size={16} aria-hidden="true" />{t("historyImport.open")}</button>
            </details>}
            <details className="panel sensor-discovery-card" aria-labelledby="sensor-discovery-title">
              <summary><span><RadioTower size={17} aria-hidden="true" /><strong id="sensor-discovery-title">{t("sensors.discovery")}</strong><small>{t("sensors.discoveryCount", { available: addableDevices.length, total: homeTpLinkDevices.length })}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
              <div>
                <div className="sensor-bridge-status"><span className={`status-pulse ${tpLinkStatus.connected ? "live" : "reconnecting"}`} aria-hidden="true" /><span><strong>{tpLinkStatus.connected ? t("common.connected") : t("status.reconnecting")}</strong><small>{t("sensors.tpLinkBridgeScope")}</small></span></div>
                {(tpLinkDevicesError || refreshError) && <p className="sensor-discovery-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{refreshError || tpLinkDevicesError}</p>}
                {(tpLinkDevicesLoading || refreshing) && <p className="sensor-discovery-loading" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.refreshing")}</p>}
                <button type="button" className="secondary-button full-width" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}><RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDevices")}</button>
              </div>
            </details>
          </aside>}
        </div>
      </>
    );
}