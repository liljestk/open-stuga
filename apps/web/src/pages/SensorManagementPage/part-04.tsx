import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MapPin,
  Plus,
  RadioTower,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { measurementLabel } from "../../measurements";
import { PlacementPicker, deviceBindingKey, normalizedMeasurementEntityIds, rounded, tpLinkDeviceSummary } from "./support";
import { useSensorManagementPagePart03 } from "./part-03";
export function useSensorManagementPagePart04(context: ReturnType<typeof useSensorManagementPagePart03>) {
  const { localAuthority, locale, t, formId, editorHeadingRef, addStep, attachSensorId, setAttachSensorId, draft, setDraft, errors, editorFeedback, submitting, enabledMeasurementDefinitions, addableDevices, attachableSensors, draftHouse, draftFloor, editingSensor, selectableDevices, currentBindingMissing, placementCoverage, placementSuggestion, clearError, cancelEditor, chooseSource, chooseDevice, attachDeviceToExistingSensor, advanceAdd, retreatAdd, submitAdd, submitEdit, renderFieldError, fieldA11y, renderDetailsFields } = context;
  const renderBindingField = () => localAuthority ? (
      <label className="field sensor-binding-field">
        <span>{t("sensors.tpLinkBinding")}</span>
        <select
          value={draft.deviceId ? deviceBindingKey(draft.deviceId, draft.connectionId) : ""}
          onChange={(event) => {
            const deviceId = event.target.value;
            const device = selectableDevices.find((candidate) => deviceBindingKey(candidate.deviceId, candidate.connectionId) === deviceId);
            setDraft((current) => ({
              ...current,
              deviceId: device?.deviceId ?? "",
              connectionId: device?.connectionId ?? "",
              source: device ? "tp-link" : "manual",
            }));
            clearError("source");
          }}
        >
          <option value="">{t("sensors.noBinding")}</option>
          {currentBindingMissing && <option value={deviceBindingKey(draft.deviceId, draft.connectionId)}>{draft.deviceId}</option>}
          {selectableDevices.map((device) => (
            <option key={deviceBindingKey(device.deviceId, device.connectionId)} value={deviceBindingKey(device.deviceId, device.connectionId)}>
              {device.alias || device.model} · {tpLinkDeviceSummary(device, t, locale)}
            </option>
          ))}
        </select>
        <small>{t("sensors.bindingHelp")}</small>
      </label>
    ) : null;
  const renderHomeAssistantBindings = () => localAuthority ? (
      <fieldset className="sensor-ha-bindings">
        <legend>{t("sensors.haBindings")}</legend>
        <p>{t("sensors.haBindingsHelp")}</p>
        <div className="sensor-ha-binding-grid">
          {enabledMeasurementDefinitions.map((definition) => {
            const label = measurementLabel(definition, locale);
            return (
              <label className="field" key={definition.id}>
                <span>{t("sensors.haEntityLabel", { measurement: label })}</span>
                <input
                  aria-label={t("sensors.haEntityLabel", { measurement: label })}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.measurementEntityIds[definition.id] ?? ""}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    measurementEntityIds: { ...current.measurementEntityIds, [definition.id]: event.target.value },
                  }))}
                  placeholder={t("sensors.haEntityPlaceholder", { metric: definition.id })}
                />
                <small>{definition.id} · {definition.unit}</small>
              </label>
            );
          })}
        </div>
      </fieldset>
    ) : null;
  const renderLocationFields = () => draftFloor ? (
      <div className="sensor-location-editor">
        <PlacementPicker
          floor={draftFloor}
          x={Number.isFinite(Number(draft.x)) ? Number(draft.x) : 0}
          y={Number.isFinite(Number(draft.y)) ? Number(draft.y) : 0}
          label={t("sensors.placementMap", { floor: draftFloor.name })}
          description={t("sensors.placementHelp")}
          coverage={placementCoverage}
          suggestion={placementSuggestion}
          onChange={(point) => {
            setDraft((current) => ({ ...current, x: String(rounded(point.x)), y: String(rounded(point.y)) }));
            clearError("x");
            clearError("y");
          }}
        />
        <div className="sensor-location-side">
          {placementSuggestion && placementCoverage && (() => {
            const recommendation = placementSuggestion.recommendation;
            const target = recommendation.roomName ?? recommendation.floorName;
            const suggestedHeight = rounded(Math.max(0, recommendation.z - draftFloor.elevation));
            const usingSuggestion = Math.abs(Number(draft.x) - recommendation.x) < .01
              && Math.abs(Number(draft.y) - recommendation.y) < .01
              && Math.abs(Number(draft.height) - suggestedHeight) < .01;
            return <section className="sensor-placement-suggestion" aria-labelledby={`${formId}-placement-suggestion-title`}>
              <header>
                <span className="sensor-suggestion-icon" aria-hidden="true"><Sparkles size={17} /></span>
                <span><small>{t("spatial.experimental")}</small><strong id={`${formId}-placement-suggestion-title`}>{t("sensors.placementSuggestionTitle")}</strong></span>
              </header>
              <p>{t("spatial.suggestion.add-temperature-anchor", { room: target })}</p>
              <div className="sensor-suggestion-evidence">
                <span>{t("sensors.placementSuggestionPointSupport", { support: Math.round(placementSuggestion.coverageAtPoint * 100) })}</span>
                <span>{t("spatial.coverage.support", { support: Math.round(placementCoverage.coverageScore * 100) })}</span>
                <span>{t("spatial.coverage.evidence", {
                  fresh: placementCoverage.freshTemperatureSensors,
                  total: placementCoverage.enabledSensors,
                  paired: placementCoverage.pairedHumiditySensors,
                })}</span>
                {placementSuggestion.engineLayerCount > 0 && <span>{t("sensors.placementSuggestionEngineBasis", {
                  count: placementSuggestion.engineLayerCount,
                  support: Math.round((placementSuggestion.engineSupport ?? 0) * 100),
                })}</span>}
              </div>
              <small className="sensor-suggestion-disclaimer">{t("spatial.suggestions.description")}</small>
              <button
                type="button"
                className="secondary-button"
                disabled={usingSuggestion}
                onClick={() => {
                  setDraft((current) => ({
                    ...current,
                    x: String(rounded(recommendation.x)),
                    y: String(rounded(recommendation.y)),
                    height: String(suggestedHeight),
                  }));
                  clearError("x");
                  clearError("y");
                  clearError("height");
                }}
              >{usingSuggestion ? <Check size={15} aria-hidden="true" /> : <MapPin size={15} aria-hidden="true" />}{t(usingSuggestion ? "sensors.placementSuggestionSelected" : "sensors.placementSuggestionUse")}</button>
            </section>;
          })()}
          <div className="sensor-coordinate-panel">
          <div className="sensor-coordinate-heading">
            <span className="sensor-coordinate-icon" aria-hidden="true"><MapPin size={17} /></span>
            <span>
              <strong>{t("sensors.position")}</strong>
              <small>{t("sensors.positionValue", { x: draft.x || "\u2014", y: draft.y || "\u2014", height: draft.height || "\u2014" })}</small>
            </span>
          </div>
          <div className="sensor-coordinate-fields">
            <label className="field">
              <span>{t("sensors.xPosition")}</span>
              <input id={`${formId}-x`} type="number" min="0" max={draftFloor.width} step="0.1" required value={draft.x} onChange={(event) => { setDraft((current) => ({ ...current, x: event.target.value })); clearError("x"); }} {...fieldA11y("x")} />
              <small className="sensor-coordinate-range" aria-hidden="true">0–{draftFloor.width}</small>
              {renderFieldError("x")}
            </label>
            <label className="field">
              <span>{t("sensors.yPosition")}</span>
              <input id={`${formId}-y`} type="number" min="0" max={draftFloor.height} step="0.1" required value={draft.y} onChange={(event) => { setDraft((current) => ({ ...current, y: event.target.value })); clearError("y"); }} {...fieldA11y("y")} />
              <small className="sensor-coordinate-range" aria-hidden="true">0–{draftFloor.height}</small>
              {renderFieldError("y")}
            </label>
            <label className="field sensor-height-field">
              <span>{t("sensors.mountingHeight")}</span>
              <span className="input-suffix"><input id={`${formId}-height`} type="number" min="0" step="0.1" required value={draft.height} onChange={(event) => { setDraft((current) => ({ ...current, height: event.target.value })); clearError("height"); }} {...fieldA11y("height")} /><span aria-hidden="true">m</span></span>
              {renderFieldError("height")}
            </label>
          </div>
        </div>
        </div>
      </div>
    ) : <p className="sensor-empty-callout" role="alert"><TriangleAlert size={17} aria-hidden="true" />{t("sensors.noFloor")}</p>;
  const renderAddEditor = () => (
      <section className="panel sensor-editor-card" aria-labelledby={`${formId}-editor-title`}>
        <header className="sensor-editor-header">
          <div>
            <span className="eyebrow">{t("sensors.guidedSetup")}</span>
            <h2 ref={editorHeadingRef} id={`${formId}-editor-title`} tabIndex={-1}>{t(`sensors.step${addStep}`)}</h2>
          </div>
          <button type="button" className="icon-button" onClick={cancelEditor} aria-label={t("sensors.cancelAdd")}><X size={18} /></button>
        </header>
        <ol className="sensor-stepper" aria-label={t("sensors.setupProgress") }>
          {([1, 2, 3, 4] as const).map((step) => <li key={step} className={step < addStep ? "complete" : step === addStep ? "active" : ""} aria-current={step === addStep ? "step" : undefined}><span>{step < addStep ? <Check size={13} aria-hidden="true" /> : step}</span><small>{t(`sensors.step${step}Short`)}</small></li>)}
        </ol>
        <form onSubmit={submitAdd} noValidate>
          {addStep === 1 && (
            <fieldset className="sensor-source-fieldset">
              <legend className="sr-only">{t("sensors.chooseSource")}</legend>
              {localAuthority && <label className={`sensor-source-choice ${draft.source === "tp-link" ? "selected" : ""}`}>
                <input type="radio" name={`${formId}-source`} checked={draft.source === "tp-link"} disabled={addableDevices.length === 0} onChange={() => chooseSource("tp-link")} />
                <span className="sensor-source-icon"><RadioTower size={20} aria-hidden="true" /></span>
                <span><strong>{t("sensors.discoveredSource")}</strong><small>{t("sensors.discoveredSourceHelp", { count: addableDevices.length })}</small></span>
              </label>}
              {localAuthority && draft.source === "tp-link" && (
                <>
                  <div className="discovered-device-list" aria-label={t("sensors.availableDevices")}>
                    {addableDevices.map((device) => (
                      <button key={deviceBindingKey(device.deviceId, device.connectionId)} type="button" className={draft.deviceId === device.deviceId && draft.connectionId === (device.connectionId ?? "") ? "selected" : ""} aria-pressed={draft.deviceId === device.deviceId && draft.connectionId === (device.connectionId ?? "")} onClick={() => chooseDevice(device)}>
                        <span className="device-radio"><span /></span>
                        <span><strong>{device.alias || t("sensors.unnamedDevice")}</strong><small>{tpLinkDeviceSummary(device, t, locale)}</small></span>
                        <span className={`device-health ${device.status?.toLowerCase() === "online" ? "online" : ""}`}>{device.status || t("sensors.unknownStatus")}</span>
                      </button>
                    ))}
                  </div>
                  {draft.deviceId && attachableSensors.length > 0 && (
                    <div className="sensor-existing-source">
                      <div><strong>{t("sensors.existingHaTitle")}</strong><p>{t("sensors.existingHaBody")}</p></div>
                      <label className="field">
                        <span>{t("sensors.existingHaSensor")}</span>
                        <select value={attachSensorId} onChange={(event) => setAttachSensorId(event.target.value)}>
                          {attachableSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.name} · {sensor.room}</option>)}
                        </select>
                      </label>
                      <button type="button" className="secondary-button" disabled={!attachSensorId} onClick={attachDeviceToExistingSensor}>
                        {t("sensors.attachExisting")}
                      </button>
                    </div>
                  )}
                </>
              )}
              <label className={`sensor-source-choice ${draft.source === "manual" ? "selected" : ""}`}>
                <input id={`${formId}-source`} type="radio" name={`${formId}-source`} checked={draft.source === "manual"} aria-describedby={errors.source ? `${formId}-source-error` : undefined} onChange={() => chooseSource("manual")} />
                <span className="sensor-source-icon manual"><Plus size={20} aria-hidden="true" /></span>
                <span><strong>{t("sensors.manualSource")}</strong><small>{t("sensors.manualSourceHelp")}</small></span>
              </label>
              {errors.source && <p className="sensor-field-error source-error" id={`${formId}-source-error`} role="alert">{errors.source}</p>}
            </fieldset>
          )}
          {addStep === 2 && <div className="sensor-editor-section">{renderDetailsFields()}{renderHomeAssistantBindings()}</div>}
          {addStep === 3 && <div className="sensor-editor-section"><p className="sensor-section-copy">{t("sensors.locationDescription")}</p>{renderLocationFields()}</div>}
          {addStep === 4 && (
            <div className="sensor-review">
              <div className="sensor-review-hero"><span className="device-glyph" aria-hidden="true"><span /><span /></span><span><small>{draft.source === "tp-link" ? t("sensors.discoveredSource") : t("sensors.manualSource")}</small><strong>{draft.name.trim()}</strong><span>{draft.model.trim()}</span></span></div>
              <dl>
                <div><dt>{t("common.house")}</dt><dd>{draftHouse?.name ?? "—"}</dd></div>
                <div><dt>{t("common.floor")}</dt><dd>{draftFloor?.name ?? "—"}</dd></div>
                <div><dt>{t("sensors.room")}</dt><dd>{draft.room.trim()}</dd></div>
                <div><dt>{t("sensors.position")}</dt><dd>{t("sensors.positionValue", { x: draft.x, y: draft.y, height: draft.height })}</dd></div>
                <div><dt>{t("sensors.tpLinkBinding")}</dt><dd>{draft.deviceId || t("sensors.noBinding")}</dd></div>
                <div><dt>{t("sensors.haBindings")}</dt><dd>{Object.keys(normalizedMeasurementEntityIds(draft.measurementEntityIds)).length > 0 ? t("sensors.haBindingCount", { count: Object.keys(normalizedMeasurementEntityIds(draft.measurementEntityIds)).length }) : t("sensors.haNoBindings")}</dd></div>
              </dl>
              <p className="sensor-review-note"><Check size={16} aria-hidden="true" />{t("sensors.reviewNote")}</p>
            </div>
          )}
          {editorFeedback && <p className={`sensor-form-feedback ${editorFeedback.kind}`} role={editorFeedback.kind === "error" ? "alert" : "status"}>{editorFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{editorFeedback.message}</p>}
          <div className="sensor-editor-actions">
            <button type="button" className="secondary-button" onClick={cancelEditor}>{t("common.cancel")}</button>
            <span />
            {addStep > 1 && <button type="button" className="secondary-button" onClick={retreatAdd}><ChevronLeft size={15} aria-hidden="true" />{t("sensors.back")}</button>}
            {addStep < 4
              ? <button type="button" className="primary-button" onClick={advanceAdd}>{t("sensors.continue")}<ChevronRight size={15} aria-hidden="true" /></button>
              : <button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{submitting ? t("sensors.adding") : t("sensors.add")}</button>}
          </div>
        </form>
      </section>
    );
  const renderEditEditor = () => editingSensor && (
      <section className="panel sensor-editor-card" aria-labelledby={`${formId}-editor-title`}>
        <header className="sensor-editor-header">
          <div><span className="eyebrow">{t("sensors.editEyebrow")}</span><h2 ref={editorHeadingRef} id={`${formId}-editor-title`} tabIndex={-1}>{t("sensors.editTitle", { name: editingSensor.name })}</h2><p>{t("sensors.stableId", { id: editingSensor.id })}</p></div>
          <button type="button" className="icon-button" onClick={cancelEditor} aria-label={t("sensors.cancelEdit")}><X size={18} /></button>
        </header>
        <form onSubmit={submitEdit} className="sensor-edit-form" noValidate>
          <section aria-labelledby={`${formId}-details-title`}><h3 id={`${formId}-details-title`}>{t("sensors.detailsSection")}</h3>{renderDetailsFields()}</section>
          <details className="sensor-edit-advanced">
            <summary><span><strong>{t("sensors.advancedEdit")}</strong><small>{t("sensors.locationSection")} · {t("sensors.connectionSection")}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
            <section aria-labelledby={`${formId}-location-title`}><h3 id={`${formId}-location-title`}>{t("sensors.locationSection")}</h3>{renderLocationFields()}</section>
            <section aria-labelledby={`${formId}-connection-title`}><h3 id={`${formId}-connection-title`}>{t("sensors.connectionSection")}</h3>{renderBindingField()}{renderHomeAssistantBindings()}<label className="sensor-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>{t("sensors.enabled")}</strong><small>{t("sensors.enabledHelp")}</small></span></label></section>
          </details>
          {editorFeedback && <p className={`sensor-form-feedback ${editorFeedback.kind}`} role={editorFeedback.kind === "error" ? "alert" : "status"}>{editorFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{editorFeedback.message}</p>}
          <div className="sensor-editor-actions"><button type="button" className="secondary-button" onClick={cancelEditor}>{t("common.cancel")}</button><span /><button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{submitting ? t("common.saving") : t("sensors.saveChanges")}</button></div>
        </form>
      </section>
    );
  return Object.assign(context, { renderBindingField, renderHomeAssistantBindings, renderLocationFields, renderAddEditor, renderEditEditor });
}