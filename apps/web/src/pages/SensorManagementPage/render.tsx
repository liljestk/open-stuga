import {
  Suspense,
} from "react";
import {
  Archive,
  Check,
  ChevronDown,
  CircleDot,
  Database,
  DoorOpen,
  Edit3,
  FileSpreadsheet,
  Home,
  LoaderCircle,
  MapPin,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  ThermometerSun,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { type TranslationKey } from "../../i18n";
import { formatInTimeZone } from "../../dateTime";
import { measurementLabel } from "../../measurements";
import { TrendChart } from "../../components/TrendChart";
import { ContactSensorHistoryPanel } from "../../components/ContactSensorHistoryPanel";
import { TpLinkContactAssignment } from "../../components/TpLinkContactAssignment";
import {
  isLegacyTpLinkContactSensor,
  tpLinkContactDeviceForSensor,
  tpLinkOpeningForDevice,
} from "../../tpLinkDeviceClassification";
import { HistoricalImportWizard, SensorLabelCard, deviceBindingKey, isDemoSensor, isGreeSensor, latestSensorTimestamp, sensorFloor } from "./support";
import type { SensorFilter } from "./support";
import { useSensorManagementPagePart04 } from "./part-04";
import { Nexus433SendersPanel } from "./Nexus433SendersPanel";
export function renderSensorManagementPage(context: ReturnType<typeof useSensorManagementPagePart04>) {
  const { state, house, houses, tpLinkDevicesLoading, tpLinkDevicesError, readOnly, localAuthority, units, onImportHistoricalData, locale, t, tpLinkStatus, pageHeadingRef, importButtonRef, detailsHeadingRef, search, setSearch, filter, modelFilter, setModelFilter, mode, pageFeedback, setPageFeedback, contactSetupDevice, contactOpenerRef, rowBusyId, cleanupBusy, refreshing, refreshError, importOpen, setImportOpen, detailsContactKey, detailSamples, detailCursor, detailsLoading, detailsError, setDetailMetric, detailRange, currentSensors, visibleDetailsSensor, visibleDetailsIsContactSensor, visibleDetailsContactDevice, visibleDetailsContactOpening, demoSensors, detailDefinitions, detailDefinition, detailHistory, homeTpLinkDevices, contactDevices, mappedContactDevices, contactHistoryDevice, contactHistoryOpening, contactStatuses, availableContactDevices, addableDevices, sensorStatuses, statusCounts, sensorModels, visibleSensors, visibleContactDevices, beginAdd, beginAddDevice, beginEdit, closeImport, loadSensorDetails, closeSensorDetails, openContactDetails, closeContactDetails, beginContactSetup, closeContactSetup, assignContactToOpening, setArchived, removeSensor, removeDemoSensors, refreshDevices, renderAddEditor, renderEditEditor } = context;
  const visibleDetailsIsGreeSensor = Boolean(visibleDetailsSensor && isGreeSensor(visibleDetailsSensor));
  const visibleSensorNameCounts = visibleSensors.reduce((counts, sensor) => {
    const key = sensor.name.trim().toLocaleLowerCase(locale);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return (
      <>
        <header className="page-heading sensor-page-heading">
          <div><span className="eyebrow"><RadioTower size={14} aria-hidden="true" />{t("sensors.eyebrow")}</span><h1 ref={pageHeadingRef} tabIndex={-1}>{t("sensors.title")}</h1><p>{t("sensors.description")}</p></div>
          {!readOnly && (currentSensors.length > 0 || mappedContactDevices.length > 0) && <button type="button" className={addableDevices.length > 0 || availableContactDevices.length > 0 ? "secondary-button" : "primary-button"} onClick={beginAdd} disabled={mode !== "closed" || cleanupBusy}><Plus size={16} aria-hidden="true" />{t("sensors.add")}</button>}
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
        {!readOnly && localAuthority && (tpLinkDevicesError || refreshError) && <p className="sensor-page-feedback error" role="alert"><TriangleAlert size={16} aria-hidden="true" />{refreshError || tpLinkDevicesError}</p>}
        {context.canManageIntegrations && <Nexus433SendersPanel house={house} sensors={currentSensors} readOnly={readOnly || !localAuthority} onAddSensor={beginAdd} />}

        {!readOnly && localAuthority && contactSetupDevice && <TpLinkContactAssignment
          device={contactSetupDevice}
          house={house}
          onAssign={assignContactToOpening}
          onClose={closeContactSetup}
        />}

        {!readOnly && localAuthority && !contactSetupDevice && mode === "closed" && addableDevices.length > 0 && <section
          className="contact-sensor-prompt sensor-ready-prompt"
          role="region"
          aria-labelledby="sensor-ready-prompt-title"
          aria-live="polite"
        >
          <span className="contact-sensor-prompt-icon" aria-hidden="true"><ThermometerSun size={21} /></span>
          <div>
            <span className="eyebrow">{t("setup.tpLinkReady")}</span>
            <h2 id="sensor-ready-prompt-title">{t(addableDevices.length > 1 ? "sensors.foundNoticeTitleMany" : "sensors.foundNoticeTitle", { count: addableDevices.length })}</h2>
            <p>{t(addableDevices.length > 1 ? "sensors.foundNoticeBodyMany" : "sensors.foundNoticeBody", {
              name: addableDevices[0]!.alias?.trim() || t("sensors.unnamedDevice"),
              model: addableDevices[0]!.model,
              count: addableDevices.length - 1,
            })}</p>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => beginAddDevice(addableDevices[0]!)}
          >
            {t("sensors.foundNoticeAdd")}
          </button>
        </section>}

        {!readOnly && localAuthority && !contactSetupDevice && mode === "closed" && addableDevices.length === 0 && availableContactDevices.length > 0 && <section
          className="contact-sensor-prompt"
          role="region"
          aria-labelledby="contact-sensor-prompt-title"
        >
          <span className="contact-sensor-prompt-icon" aria-hidden="true"><DoorOpen size={21} /></span>
          <div>
            <span className="eyebrow">{t("sensors.contactEyebrow")}</span>
            <h2 id="contact-sensor-prompt-title">{t("sensors.contactPromptTitle", {
              name: availableContactDevices[0]!.alias?.trim() || availableContactDevices[0]!.model,
            })}</h2>
            <p>{t("sensors.contactPromptBody")}</p>
            {availableContactDevices.length > 1 && <small>{t("sensors.contactPromptAdditional", { count: availableContactDevices.length - 1 })}</small>}
          </div>
          <button
            ref={contactOpenerRef}
            type="button"
            className="primary-button"
            onClick={() => beginContactSetup(availableContactDevices[0]!)}
          >
            {t("sensors.contactPromptAction")}
          </button>
        </section>}

        {!readOnly && localAuthority && tpLinkStatus.configured && !tpLinkStatus.connected && <section
          className="sensor-discovery-watch waiting"
          role="region"
          aria-label={t("sensors.discoveryStatus")}
        >
          <span className="sensor-discovery-watch-icon" aria-hidden="true">
            {tpLinkDevicesLoading || refreshing
              ? <LoaderCircle className="spin" size={19} />
              : <RefreshCw className="spin" size={19} />}
          </span>
          <span>
            <strong>{t("sensors.discoveryPausedTitle")}</strong>
            <small>{t("sensors.discoveryPaused")}</small>
          </span>
          <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}>
            <RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDeviceList")}
          </button>
        </section>}

        <section className="sensor-overview" aria-label={t("sensors.overview") }>
          <button type="button" className={filter === "waiting" ? "active" : ""} aria-pressed={filter === "waiting"} onClick={() => context.selectSensorFilter("waiting")}><span className="sensor-overview-icon waiting"><TriangleAlert size={18} aria-hidden="true" /></span><span><small>{t("sensors.waiting")}</small>{" "}<strong>{statusCounts.waiting}</strong></span></button>
          <button type="button" className={filter === "unplaced" ? "active" : ""} aria-pressed={filter === "unplaced"} onClick={() => context.selectSensorFilter("unplaced")}><span className="sensor-overview-icon unplaced"><MapPin size={18} aria-hidden="true" /></span><span><small>{t("sensors.unplaced")}</small>{" "}<strong>{statusCounts.unplaced}</strong></span></button>
          <button type="button" className={filter === "live" ? "active" : ""} aria-pressed={filter === "live"} onClick={() => context.selectSensorFilter("live")}><span className="sensor-overview-icon live"><CircleDot size={18} aria-hidden="true" /></span><span><small>{t("sensors.live")}</small>{" "}<strong>{statusCounts.live}</strong></span></button>
          <button type="button" className={filter === "archived" ? "active" : ""} aria-pressed={filter === "archived"} onClick={() => context.selectSensorFilter("archived")}><span className="sensor-overview-icon archived"><Archive size={18} aria-hidden="true" /></span><span><small>{t("sensors.archived")}</small>{" "}<strong>{statusCounts.archived}</strong></span></button>
        </section>

        {!readOnly && localAuthority && <details className="panel sensor-management-disclosure">
          <summary>
            <span><RadioTower size={17} aria-hidden="true" /><span><strong>{t("sensors.manageConnections")}</strong><small>{t("sensors.manageConnectionsBody", { sensors: currentSensors.length + mappedContactDevices.length, devices: homeTpLinkDevices.length })}</small></span></span>
            <ChevronDown size={17} aria-hidden="true" />
          </summary>
          <div className="sensor-management-body">
            {(currentSensors.length > 0 || demoSensors.length > 0) && <div className="sensor-management-actions" role="group" aria-label={t("sensors.manageConnections") }>
              {localAuthority && currentSensors.length > 0 && <button ref={importButtonRef} type="button" className="secondary-button" disabled={mode !== "closed"} onClick={() => setImportOpen(true)}><FileSpreadsheet size={16} aria-hidden="true" />{t("historyImport.open")}</button>}
              {demoSensors.length > 0 && <button type="button" className="secondary-button delete-action" onClick={() => void removeDemoSensors()} disabled={mode !== "closed" || cleanupBusy}>{cleanupBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{cleanupBusy ? t("sensors.removingDemoSensors") : t("sensors.removeDemoSensors", { count: demoSensors.length })}</button>}
            </div>}
            {localAuthority && tpLinkStatus.configured && tpLinkStatus.connected && <section className="sensor-management-connection" aria-label={t("sensors.discoveryStatus") }>
              <div className="sensor-bridge-status"><span className={`status-pulse ${tpLinkStatus.connected ? "live" : "reconnecting"}`} aria-hidden="true" /><span><strong>{tpLinkStatus.connected ? t("common.connected") : t("status.reconnecting")}</strong><small>{tpLinkStatus.connected
                ? tpLinkStatus.lastPollAt
                  ? t("sensors.discoveryLastChecked", { time: formatInTimeZone(tpLinkStatus.lastPollAt, locale, house.timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
                  : t("sensors.discoveryStarting")
                : t("sensors.discoveryPaused")}</small></span></div>
              {(tpLinkDevicesLoading || refreshing) && <p className="sensor-discovery-loading" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.refreshing")}</p>}
              <button type="button" className="secondary-button" disabled={tpLinkDevicesLoading || refreshing} onClick={() => void refreshDevices()}><RefreshCw className={tpLinkDevicesLoading || refreshing ? "spin" : ""} size={15} aria-hidden="true" />{t("sensors.refreshDevices")}</button>
            </section>}
          </div>
        </details>}

        {!readOnly && mode === "add" && renderAddEditor()}
        {!readOnly && mode === "edit" && renderEditEditor()}

        {contactHistoryDevice && <ContactSensorHistoryPanel
          key={deviceBindingKey(contactHistoryDevice.deviceId, contactHistoryDevice.connectionId)}
          device={contactHistoryDevice}
          house={house}
          opening={contactHistoryOpening}
          headingRef={detailsHeadingRef}
          onClose={closeContactDetails}
          onEdit={!readOnly && localAuthority ? () => beginContactSetup(contactHistoryDevice) : undefined}
        />}

        {visibleDetailsSensor && <section id="sensor-details-panel" className="panel sensor-details-panel" aria-labelledby="sensor-details-title">
          <header>
            <div><span className="eyebrow">{t(visibleDetailsIsContactSensor ? "sensors.contactDevice" : "sensors.dataAndLogs")}</span><h2 ref={detailsHeadingRef} id="sensor-details-title" tabIndex={-1}>{visibleDetailsSensor.name}</h2><small>{visibleDetailsSensor.id}</small></div>
            <button type="button" className="icon-button" onClick={() => closeSensorDetails()} aria-label={t("common.close")}><X size={17} /></button>
          </header>
          {visibleDetailsIsContactSensor ? <>
            <div className="sensor-details-summary">
              <span><DoorOpen size={15} aria-hidden="true" />{t("sensors.contactDevice")}</span>
              <small>{t("sensors.contactLegacyStatus")}</small>
            </div>
            <div className="sensor-contact-details">
              <div className="sensor-contact-detail-hero">
                <span className="sensor-contact-detail-icon" aria-hidden="true"><DoorOpen size={22} /></span>
                <span>
                  <small>{t("sensors.contactCurrentAssignment")}</small>
                  <strong>{visibleDetailsContactOpening?.element.label?.trim() || t("sensors.contactNotAttached")}</strong>
                  {visibleDetailsContactOpening && <span>{t(`planElement.${visibleDetailsContactOpening.element.kind}` as TranslationKey)} · {visibleDetailsContactOpening.floor.name}</span>}
                </span>
                {visibleDetailsContactDevice && <strong className={`contact-state ${visibleDetailsContactDevice.contactOpen === null || visibleDetailsContactDevice.contactOpen === undefined ? "unknown" : visibleDetailsContactDevice.contactOpen ? "open" : "closed"}`}>
                  {visibleDetailsContactDevice.contactOpen === true
                    ? t("opening.state.open")
                    : visibleDetailsContactDevice.contactOpen === false
                      ? t("opening.state.closed")
                      : t("sensors.unknownStatus")}
                </strong>}
              </div>
              <dl>
                <div><dt>{t("sensors.filterType")}</dt><dd>{t("sensors.contactDevice")}</dd></div>
                <div><dt>{t("sensors.model")}</dt><dd>{visibleDetailsContactDevice?.model || visibleDetailsSensor.model}</dd></div>
                <div><dt>{t("sensors.contactHardwareId")}</dt><dd>{visibleDetailsContactDevice?.deviceId || t("sensors.contactNotAvailable")}</dd></div>
                <div><dt>{t("sensors.contactLastUpdate")}</dt><dd>{visibleDetailsContactDevice?.lastSeenAt
                  ? formatInTimeZone(Date.parse(visibleDetailsContactDevice.lastSeenAt), locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })
                  : t("sensors.contactNotAvailable")}</dd></div>
              </dl>
              <p>{visibleDetailsContactOpening
                ? t("sensors.contactLegacyExplanation", {
                    opening: visibleDetailsContactOpening.element.label?.trim()
                      || t(`planElement.${visibleDetailsContactOpening.element.kind}` as TranslationKey),
                  })
                : t("sensors.contactLegacyUnmatchedExplanation")}</p>
            </div>
          </> : <>
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
                onRange={context.selectDetailRange}
                timeZone={house.timezone}
                heading={measurementLabel(detailDefinition, locale)}
              />
            </div>}
            <SensorLabelCard sensor={visibleDetailsSensor} />
            {visibleDetailsIsGreeSensor && <p className="sensor-details-managed-note">{t("sensors.greeManaged")}</p>}
            {detailsError && <p className="sensor-details-error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{detailsError}</p>}
            {detailSamples.length > 0 ? <div className="sensor-log-scroll" role="region" aria-labelledby="sensor-details-title" tabIndex={0}><table>
              <thead><tr><th>{t("sensors.logTime")}</th><th>{t("sensors.logMetric")}</th><th>{t("sensors.logValue")}</th><th>{t("sensors.logSource")}</th><th>{t("sensors.logQuality")}</th></tr></thead>
              <tbody>{detailSamples.map((sample, index) => <tr key={`${sample.timestamp}-${sample.metric}-${sample.source}-${index}`}>
                <td>{formatInTimeZone(Date.parse(sample.timestamp), locale, house.timezone, { dateStyle: "short", timeStyle: "medium" })}</td>
                <td>{state.measurementDefinitions.find((definition) => definition.id === sample.metric)
                  ? measurementLabel(state.measurementDefinitions.find((definition) => definition.id === sample.metric)!, locale)
                  : sample.metric}</td>
                <td>{sample.value} {sample.canonicalUnit}</td><td>{t(`measurement.source.${sample.source}` as TranslationKey)}</td><td>{t(`measurement.quality.${sample.quality}` as TranslationKey)}</td>
              </tr>)}</tbody>
            </table></div> : !detailsLoading && !detailsError ? <p className="sensor-details-empty">{t("sensors.noData")}</p> : null}
          </>}
          <footer>
            {!visibleDetailsIsContactSensor && detailsLoading && <span role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t("sensors.loadingData")}</span>}
            {!visibleDetailsIsContactSensor && !detailsLoading && detailCursor && <button type="button" className="secondary-button" onClick={() => void loadSensorDetails(visibleDetailsSensor, detailCursor)}>{t("sensors.loadMore")}</button>}
            {!readOnly && !visibleDetailsIsGreeSensor && <div className="sensor-details-actions">
              {visibleDetailsIsContactSensor && visibleDetailsContactDevice && localAuthority
                ? <button type="button" className="secondary-button" disabled={mode !== "closed" || cleanupBusy} onClick={() => beginContactSetup(visibleDetailsContactDevice)}><Edit3 size={14} aria-hidden="true" />{t("sensors.contactManageAction")}</button>
                : !visibleDetailsIsContactSensor && <>
                  <button type="button" className="secondary-button" disabled={mode !== "closed" || cleanupBusy} onClick={() => { beginEdit(visibleDetailsSensor); closeSensorDetails(); }}><Edit3 size={14} aria-hidden="true" />{t("sensors.editAction", { name: visibleDetailsSensor.name })}</button>
                  <button type="button" className="secondary-button archive-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void setArchived(visibleDetailsSensor, visibleDetailsSensor.enabled)}>{rowBusyId === visibleDetailsSensor.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : visibleDetailsSensor.enabled ? <Archive size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}{visibleDetailsSensor.enabled ? t("sensors.archiveAction", { name: visibleDetailsSensor.name }) : t("sensors.restoreAction", { name: visibleDetailsSensor.name })}</button>
                </>}
              <button type="button" className="secondary-button delete-action" disabled={mode !== "closed" || cleanupBusy || rowBusyId === visibleDetailsSensor.id} onClick={() => void removeSensor(visibleDetailsSensor)}><Trash2 size={14} aria-hidden="true" />{t("sensors.deleteAction", { name: visibleDetailsSensor.name })}</button>
            </div>}
          </footer>
        </section>}

        <div className="sensor-workspace simplified">
          {currentSensors.length === 0 && mappedContactDevices.length === 0 ? <section className="panel sensor-help-card" aria-labelledby="sensor-zero-title">
            <span className="sensor-help-icon"><ThermometerSun size={20} aria-hidden="true" /></span>
            <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-zero-title">{t("sensors.easySetup")}</h2><p>{t("sensors.easySetupHelp")}</p>{!readOnly && mode === "closed" && <button type="button" className={addableDevices.length > 0 || availableContactDevices.length > 0 ? "secondary-button" : "primary-button"} onClick={beginAdd}><Plus size={15} aria-hidden="true" />{t("sensors.startSetup")}</button>}</div>
          </section> : <section className="panel sensor-list-panel" aria-labelledby="sensor-list-title">
            <div className="sensor-list-header">
              <div><span className="eyebrow">{t("sensors.inventory")}</span><h2 id="sensor-list-title">{t("sensors.houseSensors", { house: house.name })}</h2></div>
            </div>
            <div className="sensor-list-controls">
              <label className="field sensor-search-field"><span>{t("sensors.search")}</span><span className="sensor-search"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("sensors.searchPlaceholder")} /></span></label>
              <label className="field sensor-filter"><span>{t("sensors.filterStatus")}</span><select value={filter} onChange={(event) => context.selectSensorFilter(event.target.value as SensorFilter)}><option value="all">{t("sensors.filterAll")}</option><option value="live">{t("sensors.filterLive")}</option><option value="waiting">{t("sensors.filterWaiting")}</option><option value="unplaced">{t("sensors.filterUnplaced")}</option><option value="archived">{t("sensors.filterArchived")}</option></select></label>
              <label className="field sensor-filter"><span>{t("sensors.filterType")}</span><select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="">{t("sensors.filterTypeAll")}</option>{sensorModels.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
            </div>
            {visibleSensors.length > 0 || visibleContactDevices.length > 0 ? (
              <ul className="sensor-inventory-list">
                {visibleContactDevices.map((device) => {
                  const opening = tpLinkOpeningForDevice(house, device);
                  const status = contactStatuses.get(deviceBindingKey(device.deviceId, device.connectionId)) ?? "waiting";
                  const name = device.alias?.trim() || opening?.element.label?.trim() || device.model;
                  const stateLabel = device.contactOpen === true
                    ? t("opening.state.open")
                    : device.contactOpen === false
                      ? t("opening.state.closed")
                      : t("sensors.unknownStatus");
                  return <li key={`contact-${deviceBindingKey(device.deviceId, device.connectionId)}`} className="contact-sensor-row">
                    <span className="sensor-list-glyph contact" aria-hidden="true"><DoorOpen size={19} /></span>
                    <div className="sensor-list-copy">
                      <span className="sensor-list-name"><strong>{name}</strong><span className={`sensor-status-badge ${status}`}>{t(`sensors.${status}`)}</span></span>
                      <span className="sensor-list-location"><Home size={13} aria-hidden="true" />{opening?.element.label?.trim() || t("sensors.contactNotAttached")} {opening ? `· ${opening.floor.name}` : ""}</span>
                      <small>{device.model} · {t("sensors.contactDevice")} · {stateLabel}{device.lastSeenAt ? ` · ${t("sensors.lastSeen", { time: formatInTimeZone(Date.parse(device.lastSeenAt), locale, house.timezone, { dateStyle: "short", timeStyle: "short" }) })}` : ""}</small>
                    </div>
                    <div className="sensor-list-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={cleanupBusy}
                        aria-expanded={detailsContactKey === deviceBindingKey(device.deviceId, device.connectionId)}
                        aria-controls={detailsContactKey === deviceBindingKey(device.deviceId, device.connectionId) ? "sensor-details-panel" : undefined}
                        onClick={() => openContactDetails(device)}
                      ><Database size={14} aria-hidden="true" />{t("sensors.detailsAction", { name })}</button>
                      {!readOnly && localAuthority && <button type="button" className="secondary-button" disabled={cleanupBusy || mode !== "closed"} onClick={() => beginContactSetup(device)}><Edit3 size={14} aria-hidden="true" />{t("sensors.contactManageAction")}</button>}
                    </div>
                  </li>;
                })}
                {visibleSensors.map((sensor) => {
                  const floor = sensorFloor(sensor, houses);
                  const status = sensorStatuses.get(sensor.id) ?? "waiting";
                  const lastTimestamp = latestSensorTimestamp(state, sensor.id);
                  const sensorTimeZone = houses.find((candidate) => candidate.id === sensor.houseId)?.timezone;
                  const legacyContact = isLegacyTpLinkContactSensor(sensor);
                  const greeSensor = isGreeSensor(sensor);
                  const legacyContactDevice = legacyContact ? tpLinkContactDeviceForSensor(sensor, contactDevices) : null;
                  const legacyContactOpening = legacyContactDevice ? tpLinkOpeningForDevice(house, legacyContactDevice) : null;
                  return (
                    <li key={sensor.id} className={!sensor.enabled ? "archived" : ""}>
                      <span className={`sensor-list-glyph${legacyContact ? " contact" : ""}`} aria-hidden="true">{legacyContact ? <DoorOpen size={19} /> : <><span /><span /></>}</span>
                      <div className="sensor-list-copy">
                        <span className="sensor-list-name"><strong>{sensor.name}</strong>{isDemoSensor(sensor) && <span className="sensor-demo-badge">{t("sensors.demoBadge")}</span>}<span className={`sensor-status-badge ${status}`}>{t(`sensors.${status}`)}</span></span>
                        <span className="sensor-list-location"><Home size={13} aria-hidden="true" />{legacyContactOpening?.element.label?.trim() || sensor.room} · {legacyContactOpening?.floor.name || floor?.name || t("sensors.unknownFloor")}</span>
                        <small>{sensor.model}{legacyContact
                          ? ` · ${t("sensors.contactDevice")} · ${t("sensors.contactLegacyStatus")}`
                          : greeSensor ? ` · ${t("sensors.greeSource")}` : sensor.tpLinkDeviceId ? ` · ${t("sensors.boundTo", { id: sensor.tpLinkDeviceId })}` : ` · ${t("sensors.manual")}`}{lastTimestamp ? ` · ${t("sensors.lastSeen", { time: formatInTimeZone(lastTimestamp, locale, sensorTimeZone, { dateStyle: "short", timeStyle: "short" }) })}` : ""}</small>
                      </div>
                      <div className="sensor-list-actions">
                        <button type="button" className="secondary-button" disabled={cleanupBusy} aria-label={(visibleSensorNameCounts.get(sensor.name.trim().toLocaleLowerCase(locale)) ?? 0) > 1 ? `${t("sensors.detailsAction", { name: sensor.name })} · ${t(`sensors.${status}`)}` : undefined} aria-expanded={visibleDetailsSensor?.id === sensor.id} aria-controls={visibleDetailsSensor?.id === sensor.id ? "sensor-details-panel" : undefined} onClick={() => void loadSensorDetails(sensor)}><Database size={14} aria-hidden="true" />{t("sensors.detailsAction", { name: sensor.name })}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <div className="sensor-list-empty"><Search size={22} aria-hidden="true" /><strong>{t("sensors.noMatches")}</strong><p>{t("sensors.noMatchesHelp")}</p></div>}
          </section>}

        </div>
      </>
    );
}
