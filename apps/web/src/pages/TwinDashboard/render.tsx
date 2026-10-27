import { Suspense } from "react";
import { Bolt, Box, Check, ChevronDown, DoorOpen, Edit3, Gauge, History, Home, Lightbulb, Map, MapPinPlus, Maximize2, Minimize2, Save, SlidersHorizontal, Snowflake, Sparkles, Thermometer, Wind } from "lucide-react";
import { type ConfiguredOpeningState, type ManualObservation, type MockScenario, type ObservationConfidence, type ObservationSource, type ObservationTimePrecision, type Point } from "@climate-twin/contracts";
import { ReplayControls } from "../../components/ReplayControls";
import { RoomComfortBoard } from "../../components/RoomComfortBoard";
import { MoistureCoach } from "../../components/MoistureCoach";
import { HomePulsePanelData } from "../../components/HomePulsePanel";
import { HomeOperationsPreview } from "../../components/HomeOperationsPreview";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { formatInTimeZone, twentyFourHourInputLocale } from "../../dateTime";
import { clamp } from "../../domain";
import { type TranslationKey } from "../../i18n";
import { displayUnit, formatMeasurement, formatMeasurementDelta, measurementLabel } from "../../measurements";
import { SpatialLayerPanel } from "../../components/SpatialLayerPanel";
import { HeatPumpInspector } from "../../components/HeatPumpInspector";
import { heatPumpSensorId } from "../../heatPumpPresentation";
import { BuildingScene, FloorPlan, HomeActivityTimeline, MeasurementGlyph, RoomComparisonChart, SensorInspector, SpatialLayerLab, StructureEditor, ThermalSimulationPanel, observationConfidences, observationKinds, observationSources, observationTimePrecisions } from "./support";
import { useTwinDashboardPart05 } from "./part-05";
export function renderTwinDashboard(context: ReturnType<typeof useTwinDashboardPart05>) {
  const { props, state, house, floor, houseId, floorId, units, viewMode, scenario, connection, dataMode, locale, t, sensorSourceHealthy, editing, setEditing, fullPage, setFullPage, setLiveMapOpen, historyOpen, setHistoryOpen, analysisOpen, setAnalysisOpen, fullPagePanelRef, fullPageTriggerRef, liveMapTriggerRef, pageHeadingRef, readOnly, canManageConnectedDevices, localAuthority, range, replayActive, setReplayActive, replayPlaying, replaySpeed, setReplaySpeed, replayWindowFrom, setReplayWindowFrom, replayWindowTo, setReplayWindowTo, replayResolutionSeconds, setReplayResolutionSeconds, replayLoadState, replayLoadError, replayLoadPartial, replaySampleCount, experimentalVisualizations, outdoorInfluenceMetric, setOutdoorInfluenceMetric, climateSensorsVisible, setClimateSensorsVisible, energyDevicesVisible, setEnergyDevicesVisible, connectedDevicesVisible, setConnectedDevicesVisible, heatPumps, selectedHeatPump, selectedHeatPumpId, setSelectedHeatPumpId, heatPumpInfluenceVisible, setHeatPumpInfluenceVisible, pendingHeatPumpIds, heatPumpError, heatPumpAnnouncement, placeHeatPumpOnFloor, moveHeatPump, openingStateLabelsVisible, setOpeningStateLabelsVisible, connectedDevices, pendingConnectedDeviceIds, connectedDeviceError, connectedDeviceAnnouncement, changeConnectedDevicePower, moveConnectedDevice, mapAnimationsEnabled, setMapAnimationsEnabled, outdoorExtrasVisible, setOutdoorExtrasVisible, observationPlacement, observationKind, setObservationKind, observationSeverity, setObservationSeverity, observationNote, setObservationNote, observationTimePrecision, setObservationTimePrecision, observationDateTime, setObservationDateTime, observationDate, setObservationDate, observationValidFrom, setObservationValidFrom, observationValidTo, setObservationValidTo, observationSource, setObservationSource, observationSourceDetail, setObservationSourceDetail, observationConfidence, setObservationConfidence, observationValidationError, setObservationValidationError, observationStatus, observationError, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, parameterFeedback, houseWeather, outdoorContext, houseSensors, energyDeviceCount, floorSensors, selectedSensor, selectedFloor, summarySensors, definitions, definition, metricOptions, metricLabel, replayMin, replayMax, replayEvents, replayTimestamp, setReplayTimestamp, spatialReferenceTimeMs, spatialLabOpen, setSpatialLabOpen, spatialLayers, spatialMaxSampleAgeMs, changeReplayPlaying, selectReplayEvent, loadReplayWindow, displayedSamples, mapSensorMeasurements, airflowSamples, sensorCoverage, airMovementSelected, coverageSelected, pendingOpeningStateKeys, openingStateError, openingStateAnnouncement, houseOpeningStateObservations, controllableOpenings, hasOpeningElements, changeOpeningState, experimentalFloorAirflow, experimentalBuildingAirflow, experimentalAirflowEvidence, experimentalSuggestions, outdoorInfluence, outdoorInfluenceSelected, toggleExperimentalVisualization, values, hasUsableReadings, houseColorDomain, visualOutdoor, average, spread, floorObservations, houseObservations, houseParameters, inspectorSamples, changeRange, submitObservation, placeObservation, cancelObservationPlacement, submitParameter, startEditing, finishEditing, openDecisionSensor, openDecisionRoom, liveMapVisible } = context;
  const hasMapOptions = houseSensors.length > 0 || connectedDevices.length > 0 || heatPumps.length > 0 || Boolean(outdoorContext)
    || (viewMode === "isometric" && hasOpeningElements);
  const unplacedHeatPumps = heatPumps.filter((state) => state.floorId === null);
  const selectedLiveHeatPump = replayActive ? null : selectedHeatPump;
  const selectedLiveHeatPumpId = replayActive ? null : (selectedHeatPump?.connectionId ?? selectedHeatPumpId);
  const selectMapSensor = (sensorId: string) => {
    setSelectedHeatPumpId(null);
    props.onSensorSelect(sensorId);
  };
  const selectHeatPump = (connectionId: string, targetFloorId: string) => {
    setSelectedHeatPumpId(connectionId);
    const sensor = houseSensors.find((candidate) => candidate.id === heatPumpSensorId(connectionId));
    if (sensor) props.onSensorSelect(sensor.id);
    if (targetFloorId !== floorId) props.onFloor(targetFloorId);
  };
  return (
      <>
        <header className="page-heading twin-heading">
          <div className="twin-heading-copy"><span className={`eyebrow twin-status ${dataMode === "demo" ? "demo" : connection}`}>{dataMode === "demo" ? t("demo.bannerTitle") : t(`status.${connection}`)}</span><h1 ref={pageHeadingRef} tabIndex={-1}>{house.name}</h1><p>{t("twin.description")}</p></div>
        </header>

        {!editing && !replayActive && !liveMapVisible && <>
          <div className="decision-layer">
            <HomePulsePanelData
              key={house.id}
              house={house}
              sensors={houseSensors}
              latestMeasurements={state.latestMeasurements}
              measurementHistory={state.measurementHistory}
              alerts={state.alerts}
              alertRules={state.alertRules}
              weather={houseWeather.weather}
              referenceTime={spatialReferenceTimeMs}
              dataMode={dataMode}
              onOpenTarget={openDecisionSensor}
              {...(props.onAcknowledgeAlert ? { onAcknowledge: props.onAcknowledgeAlert } : {})}
              {...(!readOnly && (localAuthority ? (sensorSourceHealthy ? props.onOpenSensors : props.onOpenConnections) : props.onOpenSensors) ? {
                onOpenSetup: localAuthority && !sensorSourceHealthy
                  ? () => props.onOpenConnections?.(houseId)
                  : () => props.onOpenSensors?.(houseId),
                setupDestination: localAuthority && !sensorSourceHealthy ? "connections" as const : "sensors" as const,
              } : {})}
            />
          </div>
          {hasUsableReadings && <section className="panel home-now" aria-label={t("twin.title")}>
            <span className={`home-now-icon measurement ${definition.colorScale}`}><MeasurementGlyph definition={definition} size={22} /></span>
            <div className="home-now-copy">
              <span className="eyebrow">{t("home.nowEyebrow")}</span>
              <small>{t("twin.averageMeasurement", { metric: `${metricLabel.charAt(0).toLocaleLowerCase(locale)}${metricLabel.slice(1)}` })}</small>
              <h2>{average == null ? t("common.noData") : formatMeasurement(average, definition, units)}</h2>
              <p>{t("home.nowSummary", {
                reporting: values.length,
                total: summarySensors.length,
                spread: spread == null ? t("common.noData") : formatMeasurementDelta(spread, definition, units),
              })}</p>
            </div>
            <button ref={liveMapTriggerRef} type="button" className="primary-button home-now-action" aria-expanded="false" aria-controls="home-live-map" onClick={() => setLiveMapOpen(true)}><Map size={16} aria-hidden="true" />{t("home.openLiveView")}</button>
          </section>}
        </>}

        {liveMapVisible && <>
        {!editing && <div className="decision-section-heading home-live-heading"><div><span className="eyebrow">{replayActive ? t("replay.title") : t("home.liveEyebrow")}</span><h2>{replayActive
          ? t("replay.active", { time: formatInTimeZone(replayTimestamp, locale, house.timezone, { dateStyle: "medium", timeStyle: "short" }) })
          : t("home.liveTitle")}</h2></div><p>{replayActive ? t("replay.description") : t("home.liveDescription")}</p></div>}
        <section id="home-live-map" ref={fullPagePanelRef} className={`panel twin-panel ${fullPage ? "is-full-page" : ""}`} role={fullPage ? "dialog" : undefined} aria-modal={fullPage ? true : undefined} aria-label={fullPage ? t("home.liveTitle") : undefined}>
          <div className="twin-toolbar">
            <div className="toolbar-context">
              <div className="toolbar-title">
                {editing
                  ? <><span className="eyebrow">{house.name}</span><strong>{t("twin.editingFloor", { floor: floor.name })}</strong></>
                  : house.floors.length > 1
                    ? <label className="toolbar-floor-picker"><span>{t("common.floor")}</span><select value={floorId} onChange={(event) => props.onFloor(event.target.value)}>{house.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    : <span className="toolbar-static-floor"><span>{t("common.floor")}</span><strong>{floor.name}</strong></span>}
              </div>
              {!editing && <label className="metric-picker"><span>{t("common.metric")}</span><select value={definition.id} onChange={(event) => props.onMetric(event.target.value)}>{metricOptions.map((item) => <option key={item.id} value={item.id}>{measurementLabel(item, locale)} · {displayUnit(item, units)}</option>)}</select></label>}
            </div>
            <div className="toolbar-navigation">
              <div className="toolbar-view-controls"><div className="segmented" role="group" aria-label={t("common.view")}><button type="button" aria-pressed={viewMode === "plan"} onClick={() => props.onViewMode("plan")}><Map size={15} aria-hidden="true" />{t("twin.mode2d")}</button><button type="button" aria-pressed={viewMode === "isometric"} onClick={() => { cancelObservationPlacement(); props.onViewMode("isometric"); }}><Box size={15} aria-hidden="true" />{t("twin.modeIso")}</button></div></div>
              {!editing && <details className="twin-view-options" onKeyDown={(event) => {
                if (event.key !== "Escape" || !event.currentTarget.open) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.open = false;
                event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
              }}>
                <summary className="secondary-button"><SlidersHorizontal size={16} aria-hidden="true" /><span>{t("twin.viewOptions")}</span><ChevronDown className="twin-view-options-chevron" size={15} aria-hidden="true" /></summary>
                <div className="twin-view-options-menu">
                  {hasMapOptions && <fieldset className="twin-layer-options"><legend>{t("twin.mapLayers")}</legend><div className="twin-option-list">
                    {houseSensors.length > energyDeviceCount && <button type="button" aria-pressed={climateSensorsVisible} onClick={() => setClimateSensorsVisible((current) => !current)}><Thermometer size={16} aria-hidden="true" /><span>{t("twin.climateSensorLayer")}</span>{climateSensorsVisible && <Check size={15} aria-hidden="true" />}</button>}
                    {energyDeviceCount > 0 && <button type="button" aria-pressed={energyDevicesVisible} onClick={() => setEnergyDevicesVisible((current) => !current)}><Bolt size={16} aria-hidden="true" /><span>{t("twin.energyDeviceLayer")}</span>{energyDevicesVisible && <Check size={15} aria-hidden="true" />}</button>}
                    {connectedDevices.length > 0 && <button type="button" aria-pressed={connectedDevicesVisible} onClick={() => setConnectedDevicesVisible((current) => !current)}><Lightbulb size={16} aria-hidden="true" /><span>{t("twin.connectedDeviceLayer")}</span>{connectedDevicesVisible && <Check size={15} aria-hidden="true" />}</button>}
                    {heatPumps.length > 0 && <button type="button" aria-pressed={heatPumpInfluenceVisible} onClick={() => setHeatPumpInfluenceVisible((current) => !current)}><Snowflake size={16} aria-hidden="true" /><span>{t("twin.heatPumpInfluenceLayer")}</span>{heatPumpInfluenceVisible && <Check size={15} aria-hidden="true" />}</button>}
                    {viewMode === "isometric" && hasOpeningElements && <button type="button" aria-pressed={openingStateLabelsVisible} onClick={() => setOpeningStateLabelsVisible((current) => !current)}><DoorOpen size={16} aria-hidden="true" /><span>{t("twin.openingStateLabels")}</span>{openingStateLabelsVisible && <Check size={15} aria-hidden="true" />}</button>}
                    {outdoorContext?.planWindFromDegrees != null && <button type="button" aria-pressed={mapAnimationsEnabled} onClick={() => setMapAnimationsEnabled((current) => !current)}><Sparkles size={16} aria-hidden="true" /><span>{t("twin.mapAnimations")}</span>{mapAnimationsEnabled && <Check size={15} aria-hidden="true" />}</button>}
                    {outdoorContext && <button type="button" aria-pressed={outdoorExtrasVisible} onClick={() => setOutdoorExtrasVisible((current) => !current)}><Wind size={16} aria-hidden="true" /><span>{t("twin.windDetails")}</span>{outdoorExtrasVisible && <Check size={15} aria-hidden="true" />}</button>}
                  </div></fieldset>}
                  <div className="twin-view-option-actions">
                    <button ref={fullPageTriggerRef} type="button" className="secondary-button twin-full-page-button" aria-pressed={fullPage} onClick={() => setFullPage((current) => !current)}>{fullPage ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}{fullPage ? t("twin.exitFullPage") : t("twin.fullPage")}</button>
                    {!readOnly && !replayActive && <button type="button" className="secondary-button" onClick={startEditing}><Edit3 size={15} aria-hidden="true" />{t("twin.editLayout")}</button>}
                  </div>
                </div>
              </details>}
              {!editing && !replayActive && !fullPage && <button type="button" className="secondary-button twin-close-live-view" aria-expanded="true" aria-controls="home-live-map" onClick={() => {
                setLiveMapOpen(false);
                window.requestAnimationFrame(() => (liveMapTriggerRef.current ?? pageHeadingRef.current)?.focus());
              }}><Minimize2 size={15} aria-hidden="true" />{t("home.hideLiveView")}</button>}
              {editing && <div className="toolbar-edit-actions"><button type="button" className="primary-button" onClick={() => void finishEditing()} disabled={props.saveState === "saving"}><Save size={15} aria-hidden="true" />{props.saveState === "saving" ? t("common.saving") : t("common.saveAndFinish")}</button><button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={props.saveState === "saving"}>{t("common.cancel")}</button></div>}
            </div>
          </div>
          {props.saveState === "error" && <p className="inline-error" role="alert">{t("twin.layoutSaveError")}</p>}
          {!editing && !replayActive && !readOnly && localAuthority && controllableOpenings.length > 0 && <div className="opening-runtime-bar">
            <span className="opening-runtime-states" aria-hidden="true"><i className="closed" /><i className="open" /></span>
            <span>{t("opening.controlHint")}</span>
          </div>}
          {openingStateError && !replayActive && <p className="inline-error opening-state-error" role="alert">{openingStateError}</p>}
          <p className="sr-only" role="status" aria-live="polite">{openingStateAnnouncement}</p>
          {connectedDeviceError && !replayActive && <p className="inline-error connected-device-error" role="alert">{connectedDeviceError}</p>}
          <p className="sr-only" role="status" aria-live="polite">{connectedDeviceAnnouncement}</p>
          {heatPumpError && !replayActive && <p className="inline-error" role="alert">{heatPumpError}</p>}
          <p className="sr-only" role="status" aria-live="polite">{heatPumpAnnouncement}</p>
          {viewMode === "plan" && !replayActive && !editing && !readOnly && canManageConnectedDevices && localAuthority && unplacedHeatPumps.map((state) => <div className="heat-pump-placement-tray" key={state.connectionId}>
            <Snowflake size={17} aria-hidden="true" />
            <span>{t("twin.heatPumpUnplaced", { device: state.name ?? state.model ?? "Gree/Wilfa" })}</span>
            <button type="button" className="secondary-button" disabled={pendingHeatPumpIds.has(state.connectionId)} onClick={() => placeHeatPumpOnFloor(state.connectionId)}><MapPinPlus size={15} aria-hidden="true" />{t("twin.heatPumpPlace")}</button>
          </div>)}
          {heatPumps.length > 0 && heatPumpInfluenceVisible && !replayActive && <div className="heat-pump-impact-legend" aria-label={t("twin.heatPumpImpactLegend")}><span className="reported"><i aria-hidden="true" />{t("twin.heatPumpReported")}</span><span className="inferred"><i aria-hidden="true" />{t("twin.heatPumpInferred")}</span></div>}
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
                connectedDevices={replayActive ? [] : connectedDevices}
                connectedDevicesVisible={connectedDevicesVisible}
                pendingConnectedDeviceIds={pendingConnectedDeviceIds}
                heatPumps={replayActive ? [] : heatPumps}
                heatPumpInfluenceVisible={heatPumpInfluenceVisible}
                pendingHeatPumpIds={pendingHeatPumpIds}
                selectedHeatPumpId={selectedLiveHeatPumpId}
                onHeatPumpSelect={selectHeatPump}
                viewMode="plan" selectedSensorId={selectedLiveHeatPump ? null : selectedSensor?.id ?? null} editing={editing} allowBackgroundImageEditing={localAuthority} observationPlacement={observationPlacement}
                referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
                outdoor={visualOutdoor}
                mapAnimationsEnabled={mapAnimationsEnabled}
                outdoorExtrasVisible={outdoorExtrasVisible}
                spatialLayerSnapshots={spatialLayers.snapshots}
                spatialLayerTopology={spatialLayers.topology}
                experimentalAirflowEnabled={airMovementSelected}
                experimentalAirflow={airMovementSelected ? experimentalFloorAirflow : null}
                experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
                experimentalOutdoorInfluence={outdoorInfluenceSelected ? outdoorInfluence : null}
                openingStateObservations={houseOpeningStateObservations}
                pendingOpeningStateKeys={pendingOpeningStateKeys}
                {...(!readOnly && localAuthority && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
                {...(!readOnly && canManageConnectedDevices && localAuthority && !replayActive && !editing ? { onConnectedDevicePowerChange: (connectionId: string, power: boolean) => { void changeConnectedDevicePower(connectionId, power); } } : {})}
                {...(!readOnly && canManageConnectedDevices && localAuthority && !replayActive && editing ? { onConnectedDeviceMove: (connectionId: string, point: Point) => { void moveConnectedDevice(connectionId, point); } } : {})}
                {...(!readOnly && canManageConnectedDevices && localAuthority && !replayActive && editing ? { onHeatPumpMove: (connectionId: string, point: Point) => { moveHeatPump(connectionId, point); } } : {})}
                onSensorSelect={selectMapSensor} onSensorMove={props.onSensorMove} onFloorChange={props.onFloorChange} onObservationPoint={placeObservation}
                onCancelObservationPlacement={cancelObservationPlacement}
              />
            ) : (
              <BuildingScene
                house={house} sensors={houseSensors} samples={displayedSamples} climateSamples={airflowSamples} observations={houseObservations} definition={definition} colorDomain={houseColorDomain} units={units}
                sensorMeasurements={mapSensorMeasurements} climateSensorMarkersVisible={climateSensorsVisible} energyDevicesVisible={energyDevicesVisible}
                connectedDevices={replayActive ? [] : connectedDevices}
                connectedDevicesVisible={connectedDevicesVisible}
                pendingConnectedDeviceIds={pendingConnectedDeviceIds}
                heatPumps={replayActive ? [] : heatPumps}
                heatPumpInfluenceVisible={heatPumpInfluenceVisible}
                selectedHeatPumpId={selectedLiveHeatPumpId}
                onHeatPumpSelect={selectHeatPump}
                activeFloorId={floorId} selectedSensorId={selectedLiveHeatPump ? null : selectedSensor?.id ?? null} onFloorSelect={props.onFloor}
                referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
                outdoor={visualOutdoor}
                mapAnimationsEnabled={mapAnimationsEnabled}
                outdoorExtrasVisible={outdoorExtrasVisible}
                editing={editing}
                spatialLayerSnapshots={spatialLayers.snapshots}
                spatialLayerTopology={spatialLayers.topology}
                experimentalAirflowEnabled={airMovementSelected}
                experimentalAirflow={airMovementSelected ? experimentalBuildingAirflow : null}
                experimentalSensorCoverage={coverageSelected ? sensorCoverage : null}
                experimentalOutdoorInfluence={outdoorInfluenceSelected ? outdoorInfluence : null}
                openingStateObservations={houseOpeningStateObservations}
                openingStateLabelsVisible={openingStateLabelsVisible}
                pendingOpeningStateKeys={pendingOpeningStateKeys}
                {...(!readOnly && localAuthority && !replayActive ? { onOpeningStateChange: (targetFloorId: string, elementId: string, nextState: ConfiguredOpeningState) => { void changeOpeningState(targetFloorId, elementId, nextState); } } : {})}
                {...(!readOnly && canManageConnectedDevices && localAuthority && !replayActive && !editing ? { onConnectedDevicePowerChange: (connectionId: string, power: boolean) => { void changeConnectedDevicePower(connectionId, power); } } : {})}
                onFloorChange={props.onFloorChange}
                onSensorSelect={(sensorId) => selectMapSensor(sensorId)}
              />
            )}
            {selectedLiveHeatPump ? <HeatPumpInspector
              state={selectedLiveHeatPump} house={house} selectedDefinition={definition} units={units} editing={editing}
              referenceTimeMs={spatialReferenceTimeMs} maxSampleAgeMs={spatialMaxSampleAgeMs}
            /> : <SensorInspector
              sensor={selectedSensor} reading={!replayActive && selectedSensor ? state.readings[selectedSensor.id] : undefined} samples={inspectorSamples}
              definitions={definitions} selectedDefinition={definition} units={units}
              house={house} floor={selectedFloor} editing={editing} onSensorUpdate={props.onSensorUpdate} onFloorSelect={props.onFloor}
            />}
          </div></Suspense>
          {!editing && spatialLabOpen && <SpatialLayerPanel
            layers={spatialLayers}
            timeZone={house.timezone}
            historyAt={replayActive ? replayTimestamp : null}
            compact
            visualization={{
              selected: experimentalVisualizations,
              mode: viewMode,
              coverage: sensorCoverage,
              airflow: experimentalAirflowEvidence,
              outdoorInfluence,
              outdoorInfluenceMetric,
              units,
              suggestions: experimentalSuggestions,
              onToggle: toggleExperimentalVisualization,
              onOutdoorInfluenceMetricChange: setOutdoorInfluenceMetric,
            }}
            onHistorySelect={(timestamp) => {
              setReplayActive(true);
              setReplayTimestamp(clamp(timestamp, replayMin, replayMax));
            }}
          />}
        </section>
        </>}

        {!editing && <details className="home-explore-disclosure">
        <summary>
          <span className="home-explore-icon" aria-hidden="true"><Home size={19} /></span>
          <span className="home-explore-summary-copy"><span className="eyebrow">{t("home.exploreEyebrow")}</span><strong>{t("home.exploreTitle")}</strong><small>{t("home.exploreDescription")}</small></span>
          <ChevronDown className="disclosure-chevron" size={19} aria-hidden="true" />
        </summary>
        <div className="home-explore-content">
        {!replayActive && hasUsableReadings && <MoistureCoach
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
        {!replayActive && hasUsableReadings && <RoomComfortBoard
          sensors={houseSensors}
          latestMeasurements={state.latestMeasurements}
          measurementHistory={state.measurementHistory}
          definitions={definitions}
          alerts={state.alerts}
          units={units}
          now={spatialReferenceTimeMs}
          onOpenRoom={openDecisionRoom}
        />}

        {!replayActive &&
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
          />}

        <section className="panel history-events-workspace" aria-labelledby="history-events-heading">
          <div className="panel-header history-events-heading">
            <div><span className="eyebrow"><History size={14} aria-hidden="true" />{t("historyEvents.eyebrow")}</span><h2 id="history-events-heading">{t("historyEvents.title")}</h2><p className="panel-intro">{t("historyEvents.description")}</p></div>
            <div className="history-events-actions"><span className="count-badge">{t("historyEvents.detectedCount", { count: replayEvents.length })}</span>{!replayActive && <button type="button" className="secondary-button" aria-expanded={historyOpen} aria-controls={historyOpen ? "history-events-controls" : undefined} onClick={() => setHistoryOpen((current) => !current)}><History size={15} aria-hidden="true" />{t(historyOpen ? "historyEvents.close" : "historyEvents.open")}</button>}</div>
          </div>
          {(historyOpen || replayActive) && <ReplayControls
            id="history-events-controls"
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
              currentOutdoorTemperatureC={visualOutdoor.context?.conditions.temperatureC}
              {...(replayActive ? { cursorTimestamp: replayTimestamp } : {})}
            />
            {!editing && !readOnly && localAuthority && <SpatialLayerLab key={houseId} houseId={houseId} sensors={houseSensors} layers={spatialLayers} onActiveChange={setSpatialLabOpen} />}

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
        {!replayActive && <nav className="home-related-views" aria-label={t("home.relatedViews")}>
          <span className="eyebrow">{t("home.relatedViews")}</span>
          <div className="context-controls">
            {!hasUsableReadings && <button type="button" className="secondary-button" aria-expanded="false" onClick={() => setLiveMapOpen(true)}><Map size={15} aria-hidden="true" />{t("home.openLiveView")}</button>}
            {props.onOpenOutdoor && <button type="button" className="secondary-button" onClick={props.onOpenOutdoor}><Wind size={15} aria-hidden="true" />{t("nav.outdoor")}</button>}
            {props.onOpenEnergy && <button type="button" className="secondary-button" onClick={props.onOpenEnergy}><Bolt size={15} aria-hidden="true" />{t("nav.energyUse")}</button>}
            {props.onOpenAnalytics && <button type="button" className="secondary-button" onClick={props.onOpenAnalytics}><Gauge size={15} aria-hidden="true" />{t("nav.analytics")}</button>}
          </div>
        </nav>}
        </div>
        </details>}
      </>
    );
}
