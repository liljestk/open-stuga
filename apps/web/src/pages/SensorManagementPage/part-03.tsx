import {
  type FormEvent,
} from "react";
import type {
  Sensor,
} from "@climate-twin/contracts";
import { type CreateSensorInput, type SensorPatch } from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import { UNPLACED_TAG, errorMessage, hasRealBinding, normalizedMeasurementEntityIds, roomCenter, rounded, sameMeasurementEntityIds, sensorMeasurementEntityIds, stableRoomId, validationErrors } from "./support";
import type { AddStep, DraftErrors, SensorDraft } from "./support";
import { useSensorManagementPagePart02 } from "./part-02";
export function useSensorManagementPagePart03(context: ReturnType<typeof useSensorManagementPagePart02>) {
  const { house, houses, integration, tpLinkDevicesLoading, readOnly, localAuthority, onHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, t, formId, setMode, addStep, setAddStep, editingSensorId, setEditingSensorId, draft, setDraft, errors, setErrors, setEditorFeedback, setPageFeedback, submitting, setSubmitting, rowBusyId, setRowBusyId, cleanupBusy, setCleanupBusy, refreshing, setRefreshing, setRefreshError, detailsSensor, demoSensors, hasExistingRealBoundSensor, draftHouse, draftFloor, editingSensor, clearError, restoreEditorFocus, cancelEditor, closeSensorDetails, changeDraftHouse, changeDraftFloor, focusFirstError, advanceAdd, buildPlacement } = context;
  const submitAdd = async (event: FormEvent) => {
      event.preventDefault();
      if (readOnly || submitting) return;
      if (addStep < 4) {
        advanceAdd();
        return;
      }
      const nextErrors = validationErrors(draft, houses, t);
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        setEditorFeedback({ kind: "error", message: t("sensors.fixFields") });
        const firstStep: AddStep = nextErrors.source ? 1
          : [nextErrors.name, nextErrors.model, nextErrors.house, nextErrors.floor, nextErrors.room].some(Boolean) ? 2 : 3;
        setAddStep(firstStep);
        focusFirstError(nextErrors);
        return;
      }
      setSubmitting(true);
      setEditorFeedback(null);
      try {
        const placement = buildPlacement();
        const measurementEntityIds = normalizedMeasurementEntityIds(draft.measurementEntityIds);
        const input: CreateSensorInput = {
          houseId: draft.houseId,
          floorId: draft.floorId,
          name: draft.name.trim(),
          roomId: stableRoomId(placement.floor, draft.room.trim()),
          room: draft.room.trim(),
          model: draft.model.trim(),
          x: placement.x,
          y: placement.y,
          z: placement.z,
          tags: [],
          enabled: true,
          ...(draft.energyMeterRole !== "standalone" ? { energyMeterRole: draft.energyMeterRole } : {}),
          ...(draft.source === "tp-link" && draft.deviceId ? {
            tpLinkDeviceId: draft.deviceId,
            ...(draft.connectionId ? { tpLinkConnectionId: draft.connectionId } : {}),
          } : {}),
          ...(Object.keys(measurementEntityIds).length > 0 ? { measurementEntityIds } : {}),
        };
        const saved = await onCreateSensor(input);
        const offerDemoCleanup = integration.mock.mode === "real"
          && demoSensors.length > 0
          && !hasExistingRealBoundSensor
          && hasRealBinding(saved);
        if (offerDemoCleanup && await confirmAction(t("sensors.cleanupConfirm", { count: demoSensors.length }), t("confirmation.cleanUp"))) {
          const results = await Promise.allSettled(demoSensors.map((sensor) => onDeleteSensor(sensor.id)));
          const selectedResultIndex = demoSensors.findIndex((sensor) => sensor.id === detailsSensor?.id);
          if (selectedResultIndex >= 0 && results[selectedResultIndex]?.status === "fulfilled") closeSensorDetails();
          const failed = results.filter((result) => result.status === "rejected").length;
          setPageFeedback(failed > 0
            ? { kind: "error", message: t("sensors.cleanupPartial", { name: saved.name, count: failed }) }
            : { kind: "success", message: t("sensors.cleanupDone", { name: saved.name, count: demoSensors.length }) });
        } else {
          setPageFeedback({ kind: "success", message: t("sensors.added", { name: saved.name }) });
        }
        setMode("closed");
        restoreEditorFocus();
        if (saved.houseId !== house.id) onHouse(saved.houseId);
      } catch (error) {
        setEditorFeedback({ kind: "error", message: errorMessage(error, t("sensors.addError")) });
      } finally {
        setSubmitting(false);
      }
    };
  const submitEdit = async (event: FormEvent) => {
      event.preventDefault();
      if (readOnly || submitting || !editingSensor) return;
      const nextErrors = validationErrors(draft, houses, t);
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        setEditorFeedback({ kind: "error", message: t("sensors.fixFields") });
        focusFirstError(nextErrors);
        return;
      }
      setSubmitting(true);
      setEditorFeedback(null);
      try {
        const placement = buildPlacement();
        const measurementEntityIds = normalizedMeasurementEntityIds(draft.measurementEntityIds);
        const existingMeasurementEntityIds = normalizedMeasurementEntityIds(sensorMeasurementEntityIds(editingSensor));
        const measurementBindingsChanged = !sameMeasurementEntityIds(measurementEntityIds, existingMeasurementEntityIds);
        const patch = {
          houseId: draft.houseId,
          floorId: draft.floorId,
          name: draft.name.trim(),
          roomId: stableRoomId(placement.floor, draft.room.trim()),
          room: draft.room.trim(),
          model: draft.model.trim(),
          x: placement.x,
          y: placement.y,
          z: placement.z,
          enabled: draft.enabled,
          ...(draft.energyMeterRole !== (editingSensor.energyMeterRole ?? "standalone")
            ? { energyMeterRole: draft.energyMeterRole }
            : {}),
          tags: editingSensor.tags.filter((tag) => tag !== UNPLACED_TAG),
          ...(localAuthority ? {
            tpLinkDeviceId: draft.deviceId || null,
            ...((editingSensor.tpLinkConnectionId !== undefined || draft.connectionId)
              ? { tpLinkConnectionId: draft.deviceId && draft.connectionId ? draft.connectionId : null }
              : {}),
            ...(measurementBindingsChanged ? { measurementEntityIds } : {}),
          } : {}),
        } as SensorPatch;
        const saved = await onUpdateSensor(editingSensor.id, patch);
        setPageFeedback({ kind: "success", message: t("sensors.updated", { name: saved.name }) });
        setMode("closed");
        setEditingSensorId(null);
        restoreEditorFocus();
        if (saved.houseId !== house.id) onHouse(saved.houseId);
      } catch (error) {
        setEditorFeedback({ kind: "error", message: errorMessage(error, t("sensors.updateError")) });
      } finally {
        setSubmitting(false);
      }
    };
  const setArchived = async (sensor: Sensor, archived: boolean) => {
      if (readOnly || rowBusyId) return;
      setRowBusyId(sensor.id);
      setPageFeedback(null);
      try {
        const saved = await onUpdateSensor(sensor.id, { enabled: !archived });
        setPageFeedback({
          kind: "success",
          message: archived ? t("sensors.archivedFeedback", { name: saved.name }) : t("sensors.restoredFeedback", { name: saved.name }),
        });
        if (editingSensorId === sensor.id) setDraft((current) => ({ ...current, enabled: saved.enabled }));
      } catch (error) {
        setPageFeedback({ kind: "error", message: errorMessage(error, archived ? t("sensors.archiveError") : t("sensors.restoreError")) });
      } finally {
        setRowBusyId(null);
      }
    };
  const removeSensor = async (sensor: Sensor) => {
      if (readOnly || rowBusyId || cleanupBusy || !await confirmAction(t("sensors.deleteConfirm", { name: sensor.name }), t("confirmation.delete"))) return;
      setRowBusyId(sensor.id);
      setPageFeedback(null);
      try {
        await onDeleteSensor(sensor.id);
        if (detailsSensor?.id === sensor.id) closeSensorDetails();
        setPageFeedback({ kind: "success", message: t("sensors.deletedFeedback", { name: sensor.name }) });
        if (editingSensorId === sensor.id) cancelEditor();
      } catch (error) {
        setPageFeedback({ kind: "error", message: errorMessage(error, t("sensors.deleteError")) });
      } finally {
        setRowBusyId(null);
      }
    };
  const removeDemoSensors = async () => {
      if (readOnly || cleanupBusy || demoSensors.length === 0
        || !await confirmAction(t("sensors.cleanupConfirm", { count: demoSensors.length }), t("confirmation.cleanUp"))) return;
      setCleanupBusy(true);
      setPageFeedback(null);
      try {
        const results = await Promise.allSettled(demoSensors.map((sensor) => onDeleteSensor(sensor.id)));
        const selectedResultIndex = demoSensors.findIndex((sensor) => sensor.id === detailsSensor?.id);
        if (selectedResultIndex >= 0 && results[selectedResultIndex]?.status === "fulfilled") closeSensorDetails();
        const failed = results.filter((result) => result.status === "rejected").length;
        setPageFeedback(failed > 0
          ? { kind: "error", message: t("sensors.demoCleanupPartial", { count: failed }) }
          : { kind: "success", message: t("sensors.demoCleanupDone", { count: demoSensors.length }) });
      } finally {
        setCleanupBusy(false);
      }
    };
  const refreshDevices = async () => {
      if (readOnly || refreshing || tpLinkDevicesLoading) return;
      setRefreshing(true);
      setRefreshError(null);
      try {
        await onRefreshDevices();
      } catch (error) {
        setRefreshError(errorMessage(error, t("sensors.discoveryError")));
      } finally {
        setRefreshing(false);
      }
    };
  const renderFieldError = (key: keyof DraftErrors) => errors[key]
      ? <span className="sensor-field-error" id={`${formId}-${key}-error`}>{errors[key]}</span>
      : null;
  const fieldA11y = (key: keyof DraftErrors) => ({
      "aria-invalid": errors[key] ? true as const : undefined,
      "aria-describedby": errors[key] ? `${formId}-${key}-error` : undefined,
    });
  const renderDetailsFields = () => (
      <div className="sensor-form-grid">
        <label className="field sensor-field-wide">
          <span>{t("sensors.name")}</span>
          <input
            id={`${formId}-name`}
            required
            autoComplete="off"
            value={draft.name}
            onChange={(event) => { setDraft((current) => ({ ...current, name: event.target.value })); clearError("name"); }}
            placeholder={t("sensors.namePlaceholder")}
            {...fieldA11y("name")}
          />
          {renderFieldError("name")}
        </label>
        <label className="field">
          <span>{t("sensors.model")}</span>
          <input
            id={`${formId}-model`}
            required
            value={draft.model}
            onChange={(event) => { setDraft((current) => ({ ...current, model: event.target.value })); clearError("model"); }}
            placeholder={t("sensors.modelPlaceholder")}
            {...fieldA11y("model")}
          />
          {renderFieldError("model")}
        </label>
        <label className="field">
          <span>{t("sensors.energyMeterRole")}</span>
          <select
            value={draft.energyMeterRole}
            onChange={(event) => setDraft((current) => ({
              ...current,
              energyMeterRole: event.target.value as SensorDraft["energyMeterRole"],
            }))}
          >
            <option value="standalone">{t("sensors.energyMeterRole.standalone")}</option>
            <option value="whole_home">{t("sensors.energyMeterRole.whole_home")}</option>
            <option value="submeter">{t("sensors.energyMeterRole.submeter")}</option>
          </select>
          <small>{t("sensors.energyMeterRoleHelp")}</small>
        </label>
        <label className="field">
          <span>{t("common.house")}</span>
          <select id={`${formId}-house`} value={draft.houseId} onChange={(event) => changeDraftHouse(event.target.value)} {...fieldA11y("house")}>
            {houses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          {renderFieldError("house")}
        </label>
        <label className="field">
          <span>{t("common.floor")}</span>
          <select id={`${formId}-floor`} value={draft.floorId} onChange={(event) => changeDraftFloor(event.target.value)} {...fieldA11y("floor")}>
            {(draftHouse?.floors ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          {renderFieldError("floor")}
        </label>
        <label className="field">
          <span>{t("sensors.room")}</span>
          <input
            id={`${formId}-room`}
            required
            list={`${formId}-rooms`}
            value={draft.room}
            onChange={(event) => {
              const room = event.target.value;
              const center = draftFloor ? roomCenter(draftFloor, room) : null;
              const exactRoom = draftFloor?.rooms.some((candidate) => candidate.name.trim().toLocaleLowerCase() === room.trim().toLocaleLowerCase());
              setDraft((current) => ({
                ...current,
                room,
                ...(center && exactRoom ? { x: String(rounded(center.x)), y: String(rounded(center.y)) } : {}),
              }));
              clearError("room");
            }}
            placeholder={t("sensors.roomPlaceholder")}
            {...fieldA11y("room")}
          />
          <datalist id={`${formId}-rooms`}>{(draftFloor?.rooms ?? []).map((room) => <option key={room.id} value={room.name} />)}</datalist>
          {renderFieldError("room")}
        </label>
      </div>
    );
  return Object.assign(context, { submitAdd, submitEdit, setArchived, removeSensor, removeDemoSensors, refreshDevices, renderFieldError, fieldA11y, renderDetailsFields });
}
