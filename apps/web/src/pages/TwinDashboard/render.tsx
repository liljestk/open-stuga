import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, BatteryMedium, Bolt, Box, Check, ChevronDown, Droplets, Edit3, Gauge, History, Home, Map, MapPinPlus, Maximize2, Minimize2, Save, Sparkles, Thermometer, Wind } from "lucide-react";
import { isAirflowPlanElement, type ConfiguredOpeningState, type ConnectionState, type Floor, type House, type ManualObservation, type ManualObservationInput, type ManualObservationPatch, type MeasurementDefinition, type MeasurementSample, type Metric, type MockScenario, type ObservationConfidence, type ObservationRevision, type ObservationSource, type ObservationTimePrecision, type OpeningStateObservation, type Point, type Reading, type Sensor, type StaticParameter, type UnitSystem } from "@climate-twin/contracts";
import { ReplayControls } from "../../components/ReplayControls";
import { RoomComfortBoard } from "../../components/RoomComfortBoard";
import { MoistureCoach } from "../../components/MoistureCoach";
import { HomePulsePanel } from "../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../components/HomeOperationsPreview";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { formatInTimeZone, twentyFourHourInputLocale } from "../../dateTime";
import { clamp, round, type ClimateState, type TimeRange, type ViewMode } from "../../domain";
import { useI18n, type TranslationKey } from "../../i18n";
import { definitionFor, displayUnit, enabledDefinitions, formatMeasurement, formatMeasurementDelta, measurementComparisonColor, measurementDomain, measurementLabel, measurementValue, samplesAt, type LatestMeasurements } from "../../measurements";
import { isEnergyDeviceSensor } from "../../energyDeviceMap";
import { configuredSpatialMaxSampleAgeMs, configuredSpatialReplayMaxSampleAgeMs, isSpatialSampleFresh } from "../../spatialFreshness";
import { createOutdoorBoundaryContext } from "../../outdoorContext";
import { useHouseWeather } from "../../useHouseWeather";
import type { OutdoorVisualizationState } from "../../components/OutdoorConditionsBadge";
import type { CreateHouseInput } from "../../components/StructureEditor";
import {
  simulateBuildingAirflow,
  simulateFloorAirflow,
  type BuildingAirflowEstimate,
  type ClimateSampleMatrix,
  type FloorAirflowEstimate,
} from "../../airflowSimulation";
import type { DataMode } from "../../useClimateData";
import { api, type MeasurementHistoryPage, type SensorPatch } from "../../api";
import { useSpatialLayers } from "../../useSpatialLayers";
import { SpatialLayerPanel } from "../../components/SpatialLayerPanel";
import {
  assessSensorCoverage,
  experimentalLayerSuggestions,
  type ExperimentalVisualizationId,
} from "../../experimentalSpatialLayers";
import { readLocalStorage, writeLocalStorage } from "../../browserStorage";
import { detectReplayClimateEvents, type ReplayClimateEvent } from "../../replayEvents";
import { openingStateCanChange, openingStateKey, openingStateObservationsForHouse } from "../../openingState";
import { integrationForHouse } from "../../integrationScope";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, energyDeviceLayerPreferenceKey, experimentalVisualizationPreferenceKey, houseLocalDateTimeCandidates, initialEnergyDeviceLayerVisibility, initialExperimentalVisualizations, localDateTimeValue, localDateValue, mergeOpeningStateObservations, observationConfidences, observationKinds, observationSources, observationTimeFields, observationTimePrecisions, zonedDateTimeParts } from "./support";
import type { TwinDashboardProps } from "./support";
import { useTwinDashboardPart05 } from "./part-05";
export function renderTwinDashboard(context: ReturnType<typeof useTwinDashboardPart05>) {
  const { props, state, house, floor, houseId, floorId, metric, units, viewMode, selectedSensorId, scenario, connection, dataMode, locale, t, scopedIntegration, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, readOnly, localAuthority, range, setRange, replayActive, setReplayActive, replayPlaying, setReplayPlaying, replayStartPending, setReplayStartPending, replayPrepared, setReplayPrepared, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayRequestedBounds, setReplayRequestedBounds, replayLoadState, setReplayLoadState, replayLoadError, setReplayLoadError, replayLoadPartial, setReplayLoadPartial, replaySampleCount, setReplaySampleCount, liveSpatialClockMs, setLiveSpatialClockMs, experimentalVisualizations, setExperimentalVisualizations, climateSensorsVisible, setClimateSensorsVisible, energyDevicesVisible, setEnergyDevicesVisible, observationPlacement, setObservationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationDraft, setObservationDraft, observationValidationError, setObservationValidationError, observationStatus, setObservationStatus, observationError, setObservationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, parameterFeedback, setParameterFeedback, replayBatchRef, replayPreparationBatchRef, airflowReplayBatchRef, inspectorReplayBatchRef, replayWindowRequestRef, previousReplayActiveRef, effectSeriesLoadsRef, loadSeriesOnce, houseWeather, outdoorContext, outdoor, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, viewSensors, summarySensors, definitions, houseDefinitions, availableDefinitions, airflowDefinitions, airflowMetricKey, definition, metricOptions, metricLabel, liveSamples, houseSensorIdList, houseSensorIds, replayMetricIds, loadedReplayBounds, fallbackReplayBounds, replayMin, replayMax, replayHistoryReady, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLayerScope, spatialLayers, liveSpatialMaxSampleAgeMs, spatialMaxSampleAgeMs, spatialFreshness, changeReplayPlaying, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, openingStateAt, openingStateObservations, setOpeningStateObservations, pendingOpeningStateKeys, setPendingOpeningStateKeys, openingStateError, setOpeningStateError, openingStateAnnouncement, setOpeningStateAnnouncement, openingStateRequestsRef, openingStateContextRef, houseOpeningStateObservations, controllableOpenings, hasOpeningElements, changeOpeningState, experimentalFloorAirflow, experimentalBuildingAirflow, experimentalAirflowEvidence, experimentalSuggestions, toggleExperimentalVisualization, values, hasUsableReadings, houseValues, activeOutdoorValue, activeOutdoorComparison, houseColorDomain, outdoorConditionColors, visualOutdoor, average, spread, openAlerts, floorObservations, houseObservations, houseParameters, inspectorSamples, changeRange, submitObservation, placeObservation, cancelObservationPlacement, submitParameter, startEditing, saveEdits, finishEditing, openDecisionSensor, liveMapVisible } = context;
  return (
      <>
        <header className="page-heading twin-heading">
          <div className="twin-heading-copy"><span className={`eyebrow twin-status ${dataMode === "demo" ? "demo" : connection}`}>{dataMode === "demo" ? t("demo.bannerTitle") : t(`status.${connection}`)}</span><h1>{t("twin.title")}</h1><p>{t("twin.description")}</p></div>
          <div className="context-controls">
            {props.onOpenActivity && <button type="button" className="secondary-button" onClick={props.onOpenActivity}><Activity size={15} aria-hidden="true" />{t("nav.activity")}</button>}
            {props.onOpenOutdoor && <button type="button" className="secondary-button" onClick={props.onOpenOutdoor}><Wind size={15} aria-hidden="true" />{t("nav.outdoor")}</button>}
            {props.onOpenEnergy && <button type="button" className="secondary-button" onClick={props.onOpenEnergy}><Bolt size={15} aria-hidden="true" />{t("nav.energyUse")}</button>}
            {props.onOpenAnalytics && <button type="button" className="secondary-button" onClick={props.onOpenAnalytics}><Gauge size={15} aria-hidden="true" />{t("nav.analytics")}</button>}
          </div>
        </header>

        {!editing && !replayActive && <>
          <div className="decision-layer">
            <HomePulsePanel
              key={house.id}
              house={house}
              sensors={houseSensors}
              latestMeasurements={state.latestMeasurements}
              measurementHistory={state.measurementHistory}
              alerts={state.alerts}
              alertRules={state.alertRules}
              weather={houseWeather.weather}
              referenceTime={spatialReferenceTimeMs}
              onOpenTarget={openDecisionSensor}
              {...(!readOnly && (localAuthority ? (sensorSourceHealthy ? props.onOpenSensors : props.onOpenConnections) : props.onOpenSensors) ? {
                onOpenSetup: localAuthority && !sensorSourceHealthy
                  ? () => props.onOpenConnections?.(houseId)
                  : () => props.onOpenSensors?.(houseId),
                setupDestination: localAuthority && !sensorSourceHealthy ? "connections" as const : "sensors" as const,
              } : {})}
            />
            {hasUsableReadings && <MoistureCoach
              sensors={houseSensors}
              latestMeasurements={state.latestMeasurements}
              conditions={houseWeather.weather?.current}
              {...(houseWeather.weather ? { weatherStale: houseWeather.weather.stale } : {})}
              units={units}
              now={spatialReferenceTimeMs}
              onOpenSensor={(sensorId) => {
                const sensor = houseSensors.find((candidate) => candidate.id === sensorId);
                if (sensor) openDecisionSensor(sensor.floorId, sensor.id);
              }}
            />}
          </div>
          {hasUsableReadings && <section className="home-status-zone" aria-labelledby="home-status-heading">
            <div className="decision-section-heading home-zone-heading">
              <div><span className="eyebrow">{t("home.statusEyebrow")}</span><h2 id="home-status-heading">{t("home.statusTitle")}</h2></div>
              <p>{t("home.statusDescription")}</p>
            </div>
            <section className="summary-strip" aria-label={t("twin.title")}>
              <div className="summary-item"><span className={`summary-icon measurement ${definition.colorScale}`}><MeasurementGlyph definition={definition} size={18} /></span><span><small>{t("twin.averageMeasurement", { metric: metricLabel })}</small><strong>{average == null ? t("common.noData") : formatMeasurement(average, definition, units)}</strong></span></div>
              <div className="summary-item"><span className="summary-icon flow"><Activity size={18} aria-hidden="true" /></span><span><small>{t("twin.reportingSensors")}</small><strong>{t("twin.reportingCount", { count: values.length, total: summarySensors.length })}</strong></span></div>
              <div className="summary-item"><span className="summary-icon flow"><Wind size={18} aria-hidden="true" /></span><span><small>{t("twin.spread")}</small><strong>{spread == null ? t("common.noData") : formatMeasurementDelta(spread, definition, units)}</strong></span></div>
              <div className={`summary-item ${openAlerts.length ? "attention" : ""}`} data-summary-scope="threshold-alerts"><span className="summary-icon alert"><AlertTriangle size={18} aria-hidden="true" /></span><span><small>{t("alerts.open")}</small><strong>{openAlerts.length === 0 ? t("twin.noActiveAlerts") : openAlerts.length === 1 ? t("twin.oneAlert") : t("twin.manyAlerts", { count: openAlerts.length })}</strong></span></div>
            </section>
          </section>}
        </>}

        {!liveMapVisible && <section className="panel home-live-launcher" aria-labelledby="home-live-launcher-title"><div><span className="eyebrow">{t("home.liveEyebrow")}</span><h2 id="home-live-launcher-title">{t("home.liveTitle")}</h2><p>{t("home.liveDescription")}</p></div><button type="button" className="secondary-button" aria-expanded="false" onClick={() => setLiveMapOpen(true)}><Map size={15} aria-hidden="true" />{t("home.openLiveView")}</button></section>}
        {liveMapVisible && <>
        {!editing && <div className="decision-section-heading home-live-heading"><div><span className="eyebrow">{replayActive ? t("replay.title") : t("home.liveEyebrow")}</span><h2>{replayActive
          ? t("replay.active", { time: formatInTimeZone(replayTimestamp, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }) })
          : t("home.liveTitle")}</h2></div><p>{replayActive ? t("replay.description") : t("home.liveDescription")}</p></div>}
        <section ref={fullPagePanelRef} className={`panel twin-panel ${fullPage ? "is-full-page" : ""}`} role={fullPage ? "dialog" : undefined} aria-modal={fullPage ? true : undefined} aria-label={fullPage ? t("home.liveTitle") : undefined}>
          <div className="twin-toolbar">
            <div className="toolbar-context">
              <div className="toolbar-title">
                {editing
                  ? <><span className="eyebrow">{house.name}</span><strong>{t("twin.editingFloor", { floor: floor.name })}</strong></>
                  : house.floors.length > 1
                    ? <><label className="toolbar-floor-picker"><span>{t("common.floor")}</span><select value={floorId} onChange={(event) => props.onFloor(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><strong>{viewSensors.length} {t("twin.sensors")}</strong></>
                    : <><span className="eyebrow">{floor.name}</span><strong>{viewSensors.length} {t("twin.sensors")}</strong></>}
              </div>
              {!editing && <label className="metric-picker"><span>{t("common.metric")}</span><select value={definition.id} onChange={(event) => props.onMetric(event.target.value)}>{metricOptions.map((item) => <option key={item.id} value={item.id}>{measurementLabel(item, locale)} · {displayUnit(item, units)}</option>)}</select></label>}
            </div>
            <div className="toolbar-groups">
              <div className="toolbar-view-controls">
                <div className="segmented" role="group" aria-label={t("common.view")}><button type="button" aria-pressed={viewMode === "plan"} onClick={() => props.onViewMode("plan")}><Map size={15} aria-hidden="true" />{t("twin.mode2d")}</button><button type="button" aria-pressed={viewMode === "isometric"} onClick={() => { cancelObservationPlacement(); props.onViewMode("isometric"); }}><Box size={15} aria-hidden="true" />{t("twin.modeIso")}</button></div>
                {!editing && houseSensors.length > 0 && <div className="segmented compact map-device-layers" role="group" aria-label={t("twin.mapLayers")}>
                  {houseSensors.length > energyDeviceCount && <button type="button" aria-pressed={climateSensorsVisible} onClick={() => setClimateSensorsVisible((current) => !current)}><Thermometer size={15} aria-hidden="true" />{t("twin.climateSensorLayer")}</button>}
                  {energyDeviceCount > 0 && <button type="button" aria-pressed={energyDevicesVisible} onClick={() => setEnergyDevicesVisible((current) => !current)}><Bolt size={15} aria-hidden="true" />{t("twin.energyDeviceLayer")}</button>}
                </div>}
              </div>
              <div className="toolbar-actions">
                {!editing && <button ref={fullPageTriggerRef} type="button" className="secondary-button twin-full-page-button" aria-pressed={fullPage} onClick={() => setFullPage((current) => !current)}>{fullPage ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}{fullPage ? t("twin.exitFullPage") : t("twin.fullPage")}</button>}
                {!editing && !replayActive && !fullPage && <button type="button" className="secondary-button" onClick={() => setLiveMapOpen(false)}><Minimize2 size={15} aria-hidden="true" />{t("home.hideLiveView")}</button>}
                {!readOnly && !editing && <button type="button" className="secondary-button" onClick={startEditing}><Edit3 size={15} aria-hidden="true" />{t("common.edit")}</button>}
                {editing && <><button type="button" className="primary-button" onClick={() => void finishEditing()} disabled={props.saveState === "saving"}><Save size={15} aria-hidden="true" />{props.saveState === "saving" ? t("common.saving") : t("common.saveAndFinish")}</button><button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={props.saveState === "saving"}>{t("common.cancel")}</button></>}
              </div>
            </div>
          </div>
          {props.saveState === "error" && <p className="inline-error" role="alert">{t("twin.layoutSaveError")}</p>}
          {!editing && !replayActive && !readOnly && localAuthority && controllableOpenings.length > 0 && <div className="opening-runtime-bar">
            <span className="opening-runtime-states" aria-hidden="true"><i className="closed" /><i className="open" /></span>
            <span>{t("opening.controlHint")}</span>
          </div>}
          {openingStateError && !replayActive && <p className="inline-error opening-state-error" role="alert">{openingStateError}</p>}
          <p className="sr-only" role="status" aria-live="polite">{openingStateAnnouncement}</p>
          {!editing && <SpatialLayerPanel
            layers={spatialLayers}
            timeZone={house.timezone}
            historyAt={replayActive ? replayTimestamp : null}
            compact
            visualization={{
              selected: experimentalVisualizations,
              mode: viewMode,
              coverage: sensorCoverage,
              airflow: experimentalAirflowEvidence,
              suggestions: experimentalSuggestions,
              onToggle: toggleExperimentalVisualization,
            }}
            onHistorySelect={(timestamp) => {
              setReplayActive(true);
              setReplayTimestamp(clamp(timestamp, replayMin, replayMax));
            }}
          />}
          <Suspense fallback={<output className="page-loading">{t("common.loading")}</output>}><div className={`twin-grid ${editing ? "is-editing" : ""}`}>
            {editing && (
              <StructureEditor
                houses={state.houses} house={house} floor={floor} sensors={state.sensors}
                onHouseSelect={props.onHouse} onFloorSelect={props.onFloor}
                {...(props.onHouseChange ? { onHouseChange: props.onHouseChange } : {})}
                onHouseSave={props.onSaveLayout}
                {...(props.onHouseCreate ? { onHouseCreate: props.onHouseCreate } : {})}
                {...(props.onHouseDelete ? { onHouseDelete: props.onHouseDelete } : {})}
              />
            )}
            {viewMode === "plan" ? (
              <FloorPlan
                floor={floor} house={house} sensors={floorSensors} samples={displayedSamples} climateSamples={airflowSamples} observations={floorObservations} definition={definition} colorDomain={houseColorDomain} units={units}
                sensorMeasurements={mapSensorMeasurements} climateSensorMarkersVisible={climateSensorsVisible} energyDevicesVisible={energyDevicesVisible}
                viewMode="plan" selectedSensorId={selectedSensor?.id ?? null} editing={editing} allowBackgroundImageEditing={localAuthority} observationPlacement={observationPlacement}
                referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
                outdoor={visualOutdoor}
                spatialLayerSnapshots={spatialLayers.snapshots}
                spatialLayerTopology={spatialLayers.topology}
                experimentalAirflowEnabled={airMovementSelected}
                experimentalAirflow={airMovementSelected ? experimentalFloorAirflow : null}
                experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
                openingStateObservations={houseOpeningStateObservations}
                pendingOpeningStateKeys={pendingOpeningStateKeys}
                {...(!readOnly && localAuthority && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
                onSensorSelect={props.onSensorSelect} onSensorMove={props.onSensorMove} onFloorChange={props.onFloorChange} onObservationPoint={placeObservation}
                onCancelObservationPlacement={cancelObservationPlacement}
              />
            ) : (
              <BuildingScene
                house={house} sensors={houseSensors} samples={displayedSamples} climateSamples={airflowSamples} observations={houseObservations} definition={definition} colorDomain={houseColorDomain} units={units}
                sensorMeasurements={mapSensorMeasurements} climateSensorMarkersVisible={climateSensorsVisible} energyDevicesVisible={energyDevicesVisible}
                activeFloorId={floorId} selectedSensorId={selectedSensor?.id ?? null} onFloorSelect={props.onFloor}
                referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
                outdoor={visualOutdoor}
                editing={editing}
                spatialLayerSnapshots={spatialLayers.snapshots}
                spatialLayerTopology={spatialLayers.topology}
                experimentalAirflowEnabled={airMovementSelected}
                experimentalAirflow={airMovementSelected ? experimentalBuildingAirflow : null}
                experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
                openingStateObservations={houseOpeningStateObservations}
                pendingOpeningStateKeys={pendingOpeningStateKeys}
                {...(!readOnly && localAuthority && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
                onFloorChange={props.onFloorChange}
                onSensorSelect={(sensorId) => props.onSensorSelect(sensorId)}
              />
            )}
            <SensorInspector
              sensor={selectedSensor} reading={!replayActive && selectedSensor ? state.readings[selectedSensor.id] : undefined} samples={inspectorSamples}
              definitions={definitions} selectedDefinition={definition} units={units}
              house={house} floor={selectedFloor} editing={editing} onSensorUpdate={props.onSensorUpdate} onFloorSelect={props.onFloor}
            />
          </div></Suspense>
        </section>
        </>}

        {!editing && <>
        {!replayActive && hasUsableReadings && <RoomComfortBoard
          sensors={houseSensors}
          latestMeasurements={state.latestMeasurements}
          measurementHistory={state.measurementHistory}
          definitions={definitions}
          alerts={state.alerts}
          units={units}
          now={spatialReferenceTimeMs}
          onOpenRoom={openDecisionSensor}
        />}

        {!replayActive && <div className="home-secondary-grid">
          <HomeOperationsPreview
            sensors={houseSensors}
            alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
            observations={houseObservations}
            maintenanceTasks={state.maintenanceTasks.filter((task) => task.houseId === houseId)}
            warnings={houseWeather.weather?.warnings ?? []}
            integration={state.integration}
            timeZone={house.timezone}
            {...(props.onOpenActivity ? { onOpenActivity: props.onOpenActivity } : {})}
            {...(props.onOpenMaintenance ? { onOpenMaintenance: props.onOpenMaintenance } : {})}
          />
        </div>}

        <section className="panel history-events-workspace" aria-labelledby="history-events-heading">
          <div className="panel-header history-events-heading">
            <div><span className="eyebrow"><History size={14} aria-hidden="true" />{t("historyEvents.eyebrow")}</span><h2 id="history-events-heading">{t("historyEvents.title")}</h2><p className="panel-intro">{t("historyEvents.description")}</p></div>
            <div className="history-events-actions"><span className="count-badge">{t("historyEvents.detectedCount", { count: replayEvents.length })}</span>{!replayActive && <button type="button" className="secondary-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)}><History size={15} aria-hidden="true" />{t(historyOpen ? "historyEvents.close" : "historyEvents.open")}</button>}</div>
          </div>
          {(historyOpen || replayActive) && <ReplayControls
            active={replayActive}
            playing={replayPlaying}
            timestamp={replayTimestamp}
            min={replayMin}
            max={replayMax}
            speed={replaySpeed}
            timeZone={house.timezone}
            events={replayEvents}
            sensors={houseSensors}
            definitions={definitions}
            units={units}
            onActive={(active) => { setReplayActive(active); if (active) { setHistoryOpen(true); setLiveMapOpen(true); } }}
            onPlaying={changeReplayPlaying}
            onTimestamp={setReplayTimestamp}
            onSpeed={setReplaySpeed}
            onEventSelect={selectReplayEvent}
            {...(props.onLoadReplaySeries ? {
              windowFrom: replayWindowFrom,
              windowTo: replayWindowTo,
              resolutionSeconds: replayResolutionSeconds,
              loading: replayLoadState === "loading",
              partial: replayLoadPartial,
              loadError: replayLoadError,
              onWindowFrom: setReplayWindowFrom,
              onWindowTo: setReplayWindowTo,
              onResolution: setReplayResolutionSeconds,
              onLoadWindow: () => { void loadReplayWindow(); },
            } : {})}
            {...(replaySampleCount === null ? {} : { sampleCount: replaySampleCount })}
          />}
        </section>

        <details className="home-tools-disclosure" open={analysisOpen}>
          <summary onClick={(event) => { event.preventDefault(); setAnalysisOpen((current) => !current); }}>
            <span className="home-tools-icon" aria-hidden="true"><History size={20} /></span>
            <span><span className="eyebrow">{t("home.toolsSummary")}</span><strong>{t("home.toolsTitle")}</strong><small>{t("home.toolsDescription")}</small></span>
            <ChevronDown className="disclosure-chevron" size={19} aria-hidden="true" />
          </summary>
          {analysisOpen && <Suspense fallback={<output className="page-loading">{t("common.loading")}</output>}><div className="home-tools-content">
            <ThermalSimulationPanel
              houseId={houseId}
              sensor={selectedSensor}
              range={range}
              units={units}
              timeZone={house.timezone}
              currentOutdoorTemperatureC={houseWeather.weather?.current?.temperatureC}
              {...(replayActive ? { cursorTimestamp: replayTimestamp } : {})}
            />
            {!readOnly && localAuthority && <SpatialLayerLab houseId={houseId} sensors={houseSensors} layers={spatialLayers} />}

            <div className="lower-grid">
          <RoomComparisonChart
            sensors={houseSensors}
            selectedSensorId={selectedSensor?.id ?? null}
            history={state.measurementHistory}
            definition={definition}
            units={units}
            range={range}
            weather={houseWeather.weather}
            alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
            observations={houseObservations}
            warnings={houseWeather.weather?.warnings ?? []}
            timeZone={house.timezone}
            onRange={changeRange}
            onLoadSeries={(sensorId) => props.onLoadSeries(sensorId, definition.id, range, definition.forecastSupported)}
          />
          <div className="side-stack">
            <HomeActivityTimeline
              sensors={houseSensors}
              alerts={state.alerts.filter((alert) => houseSensors.some((sensor) => sensor.id === alert.sensorId))}
              observations={houseObservations}
              maintenanceTasks={state.maintenanceTasks.filter((task) => task.houseId === houseId)}
              warnings={houseWeather.weather?.warnings ?? []}
              integration={state.integration}
              timeZone={house.timezone}
              {...(!readOnly && props.onUpdateObservation ? { onUpdateObservation: props.onUpdateObservation } : {})}
              {...(!readOnly && props.onReloadObservation ? { onReloadObservation: props.onReloadObservation } : {})}
              {...(props.onLoadObservationRevisions ? { onLoadObservationRevisions: props.onLoadObservationRevisions } : {})}
              onOpenSensor={openDecisionSensor}
              onOpenFloor={(targetFloorId) => { props.onFloor(targetFloorId); props.onViewMode("plan"); }}
            />
            {!readOnly && localAuthority && dataMode === "demo" && <section className="panel compact-panel">
              <div className="panel-header"><div><h2>{t("mock.title")}</h2><p className="panel-intro">{t("mock.description")}</p></div></div>
              <label className="field"><span>{t("mock.scenario")}</span><select value={scenario} onChange={(event) => props.onRunScenario(event.target.value as MockScenario["id"])}>{state.scenarios.map((item) => <option key={item.id} value={item.id}>{t(`mock.${item.id}` as TranslationKey)}</option>)}</select></label>
              <p className="field-help">{t(`mock.${scenario}Description` as TranslationKey)}</p>
              <button type="button" className="secondary-button full-width" onClick={() => props.onRunScenario(scenario)}><Sparkles size={15} aria-hidden="true" />{t("mock.start")}</button>
            </section>}
            {!readOnly && <section className="panel compact-panel observation-panel">
              <div className="panel-header"><div><span className="eyebrow">{floor.name}</span><h2>{t("observations.title")}</h2></div><span className="count-badge">{floorObservations.length}</span></div>
              <form onSubmit={submitObservation} className="observation-form">
                <fieldset className="observation-fields" disabled={observationPlacement}>
                  <legend className="sr-only">{t("observations.details")}</legend>
                  <div className="field-row"><label className="field"><span>{t("observations.kind")}</span><select value={observationKind} onChange={(event) => setObservationKind(event.target.value as ManualObservation["kind"])}>{observationKinds.map((kind) => <option key={kind} value={kind}>{t(`observations.${kind === "note" ? "noteKind" : kind}` as TranslationKey)}</option>)}</select></label><label className="field"><span>{t("alerts.severity")}</span><select value={observationSeverity} onChange={(event) => setObservationSeverity(event.target.value as ManualObservation["severity"])}><option value="info">{t("alerts.info")}</option><option value="warning">{t("alerts.warning")}</option><option value="critical">{t("alerts.critical")}</option></select></label></div>
                  <label className="field"><span>{t("observations.timePrecision")}</span><select value={observationTimePrecision} onChange={(event) => { setObservationTimePrecision(event.target.value as ObservationTimePrecision); setObservationValidationError(false); }}>{observationTimePrecisions.map((precision) => <option key={precision} value={precision}>{t(`observations.precision.${precision}` as TranslationKey)}</option>)}</select></label>
                  {(observationTimePrecision === "exact" || observationTimePrecision === "approximate") && <label className="field"><span>{t("observations.observedAt")}</span><input type="datetime-local" lang={twentyFourHourInputLocale(locale)} required value={observationDateTime} onChange={(event) => setObservationDateTime(event.target.value)} /><small>{t("observations.localTimeHelp")}</small></label>}
                  {observationTimePrecision === "date-only" && <label className="field"><span>{t("observations.observedDate")}</span><input type="date" required value={observationDate} onChange={(event) => setObservationDate(event.target.value)} /></label>}
                  {observationTimePrecision === "date-range" && <div className="field-row"><label className="field"><span>{t("observations.validFrom")}</span><input type="date" required max={observationValidTo} value={observationValidFrom} onChange={(event) => setObservationValidFrom(event.target.value)} /></label><label className="field"><span>{t("observations.validTo")}</span><input type="date" required min={observationValidFrom} value={observationValidTo} onChange={(event) => setObservationValidTo(event.target.value)} /></label></div>}
                  {observationTimePrecision === "unknown" && <p className="field-help observation-time-help">{t("observations.unknownTimeHelp")}</p>}
                  <div className="field-row"><label className="field"><span>{t("observations.source")}</span><select value={observationSource} onChange={(event) => setObservationSource(event.target.value as ObservationSource)}>{observationSources.map((source) => <option key={source} value={source}>{t(`observations.source.${source}` as TranslationKey)}</option>)}</select></label><label className="field"><span>{t("observations.confidence")}</span><select value={observationConfidence} onChange={(event) => setObservationConfidence(event.target.value as ObservationConfidence)}>{observationConfidences.map((confidence) => <option key={confidence} value={confidence}>{t(`observations.confidence.${confidence}` as TranslationKey)}</option>)}</select></label></div>
                  <label className="field"><span>{t("observations.sourceDetail")}</span><input value={observationSourceDetail} onChange={(event) => setObservationSourceDetail(event.target.value)} placeholder={t("observations.sourceDetailPlaceholder")} /></label>
                  <label className="field"><span>{t("observations.note")}</span><input value={observationNote} onChange={(event) => setObservationNote(event.target.value)} placeholder={t("observations.notePlaceholder")} /></label>
                </fieldset>
                <button type="submit" className={observationPlacement ? "primary-button full-width" : "secondary-button full-width"}><MapPinPlus size={15} aria-hidden="true" />{observationPlacement ? t("observations.locationHint") : t("observations.add")}</button>
                {observationValidationError && <p className="inline-error" role="alert">{t("observations.invalidTime")}</p>}
                {observationStatus && <p className="success-message" role="status"><Check size={15} aria-hidden="true" />{t("observations.logged")}</p>}
                {observationError && <p className="inline-error" role="alert">{t("observations.saveFailed")}</p>}
              </form>
            </section>}
            <section className="panel compact-panel context-panel">
              <div className="panel-header"><div><h2>{t("context.title")}</h2><p className="panel-intro">{t("context.description")}</p></div><span className="count-badge">{houseParameters.length}</span></div>
              {houseParameters.length > 0 && <dl className="parameter-list">{houseParameters.slice(0, 5).map((parameter) => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{String(parameter.value)}{parameter.unit ? ` ${parameter.unit}` : ""}</dd></div>)}</dl>}
              {!readOnly && localAuthority && <form onSubmit={submitParameter} className="context-form">
                <label className="field"><span>{t("context.label")}</span><input required value={parameterLabel} onChange={(event) => setParameterLabel(event.target.value)} placeholder={t("context.labelPlaceholder")} /></label>
                <div className="field-row"><label className="field"><span>{t("context.value")}</span><input required value={parameterValue} onChange={(event) => setParameterValue(event.target.value)} placeholder={t("context.valuePlaceholder")} /></label><label className="field"><span>{t("context.unit")}</span><input value={parameterUnit} onChange={(event) => setParameterUnit(event.target.value)} placeholder={t("common.optional")} /></label></div>
                <button type="submit" className="secondary-button full-width" disabled={parameterPending}>{parameterPending ? t("common.saving") : t("context.add")}</button>
                {parameterFeedback === "saved" && <p className="success-message" role="status"><Check size={15} aria-hidden="true" />{t("context.saved")}</p>}
                {parameterFeedback === "error" && <p className="inline-error" role="alert">{t("context.saveFailed")}</p>}
              </form>}
            </section>
          </div>
            </div>
          </div></Suspense>}
        </details>
        </>}
      </>
    );
}
