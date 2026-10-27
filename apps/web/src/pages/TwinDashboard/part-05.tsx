import { type FormEvent } from "react";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { createClientUuid } from "../../clientUuid";
import { useTwinDashboardPart04 } from "./part-04";
export function useTwinDashboardPart05(context: ReturnType<typeof useTwinDashboardPart04>) {
  const { props, house, houseId, editing, setEditing, fullPage, setFullPage, liveMapOpen, setLiveMapOpen, readOnly, localAuthority, replayActive, parameterLabel, setParameterLabel, parameterValue, setParameterValue, parameterUnit, setParameterUnit, parameterPending, setParameterPending, setParameterFeedback, cancelObservationPlacement } = context;
  const submitParameter = async (event: FormEvent) => {
      event.preventDefault();
      const label = parameterLabel.trim();
      const value = parameterValue.trim();
      if (readOnly || !localAuthority || !label || !value || parameterPending) return;
      setParameterPending(true);
      setParameterFeedback(null);
      try {
        await props.onCreateStaticParameter({
          houseId,
          scopeType: "house",
          scopeId: houseId,
          key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || createClientUuid(),
          label,
          value,
          unit: parameterUnit.trim() || null,
        });
        setParameterLabel("");
        setParameterValue("");
        setParameterUnit("");
        setParameterFeedback("saved");
      } catch {
        setParameterFeedback("error");
      } finally {
        setParameterPending(false);
      }
    };
  const startEditing = () => {
      if (readOnly) return;
      setFullPage(false);
      setEditing(true);
      cancelObservationPlacement();
    };
  const saveEdits = async () => {
      if (readOnly) return false;
      try {
        await props.onSaveLayout(house);
        return true;
      } catch {
        return false;
      }
    };
  const finishEditing = async () => {
      if (await saveEdits()) setEditing(false);
    };
  const openDecisionSensor = (targetFloorId: string, sensorId: string) => {
      props.onFloor(targetFloorId);
      props.onSensorSelect(sensorId);
      props.onViewMode("plan");
      setLiveMapOpen(true);
    };
  const openDecisionRoom = (targetFloorId: string, _roomId: string | null) => {
      props.onFloor(targetFloorId);
      props.onSensorSelect(null);
      props.onViewMode("plan");
      setLiveMapOpen(true);
    };
  const liveMapVisible = liveMapOpen || editing || replayActive || fullPage;
  return Object.assign(context, { submitParameter, startEditing, saveEdits, finishEditing, openDecisionSensor, openDecisionRoom, liveMapVisible });
}
