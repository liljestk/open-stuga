import { useEffect, useMemo, useRef, useState } from "react";
import "../../components/decisionLayer.css";
import "../OperationsPages.css";
import { type TimeRange } from "../../domain";
import type { TwinDashboardProps } from "./support";
import { useTwinDashboardPart01 } from "./part-01";
import { useTwinDashboardPart02 } from "./part-02";
import { useTwinDashboardPart03 } from "./part-03";
import { useTwinDashboardPart04 } from "./part-04";
import { useTwinDashboardPart05 } from "./part-05";
import { renderTwinDashboard } from "./render";
import {
  readTwinDashboardHomeView,
  readTwinDashboardQuerySelection,
  selectionWithFloor,
  twinDashboardQueryOptions,
  twinDashboardQueryHasMeaningfulSelection,
  writeTwinDashboardHomeView,
  writeTwinDashboardQuerySelection,
  type TwinDashboardHomeView,
  type TwinDashboardQuerySelection,
} from "./queryState";

function selectionFromProps(props: TwinDashboardProps, range: TimeRange): TwinDashboardQuerySelection {
  return {
    floorId: props.floorId,
    metric: props.metric,
    viewMode: props.viewMode,
    selectedSensorId: props.selectedSensorId,
    range,
  };
}

function useTwinDashboardQueryState(props: TwinDashboardProps) {
  const options = useMemo(() => twinDashboardQueryOptions(props), [
    props.floorId,
    props.house,
    props.houseId,
    props.metric,
    props.state.measurementDefinitions,
    props.state.sensors,
  ]);
  const scopeKey = useMemo(() => [
    props.houseId,
    options.floorIds.join("\u0001"),
    options.metricIds.join("\u0001"),
    options.sensors.map((sensor) => `${sensor.id}:${sensor.floorId}`).join("\u0001"),
  ].join("\u0002"), [options, props.houseId]);
  const [range, setRangeState] = useState<TimeRange>(() => (
    readTwinDashboardQuerySelection(
      window.location.search,
      options,
      selectionFromProps(props, "24h"),
    ).range
  ));
  const optionsRef = useRef(options);
  const callbacksRef = useRef(props);
  const rangeRef = useRef(range);
  const renderedSelectionRef = useRef(selectionFromProps(props, range));
  const selectionRef = useRef(selectionFromProps(props, range));
  const [meaningfulQueryState, setMeaningfulQueryState] = useState(() => (
    twinDashboardQueryHasMeaningfulSelection(window.location.search, options)
  ));
  const [homeView, setHomeViewState] = useState<TwinDashboardHomeView>(() => (
    readTwinDashboardHomeView(window.location.search)
  ));

  optionsRef.current = options;
  callbacksRef.current = props;
  rangeRef.current = range;

  const renderedSelection = selectionFromProps(props, range);
  const previousRendered = renderedSelectionRef.current;
  const pendingSelection = selectionRef.current;
  if (renderedSelection.floorId !== previousRendered.floorId) pendingSelection.floorId = renderedSelection.floorId;
  if (renderedSelection.metric !== previousRendered.metric) pendingSelection.metric = renderedSelection.metric;
  if (renderedSelection.viewMode !== previousRendered.viewMode) pendingSelection.viewMode = renderedSelection.viewMode;
  if (renderedSelection.selectedSensorId !== previousRendered.selectedSensorId) {
    pendingSelection.selectedSensorId = renderedSelection.selectedSensorId;
  }
  if (renderedSelection.range !== previousRendered.range) pendingSelection.range = renderedSelection.range;
  renderedSelectionRef.current = renderedSelection;

  const applySelection = (next: TwinDashboardQuerySelection) => {
    const currentProps = callbacksRef.current;
    selectionRef.current = next;
    if (next.floorId !== currentProps.floorId) currentProps.onFloor(next.floorId);
    if (next.metric !== currentProps.metric) currentProps.onMetric(next.metric);
    if (next.viewMode !== currentProps.viewMode) currentProps.onViewMode(next.viewMode);
    if (next.selectedSensorId !== currentProps.selectedSensorId) currentProps.onSensorSelect(next.selectedSensorId);
    if (next.range !== rangeRef.current) {
      rangeRef.current = next.range;
      setRangeState(next.range);
    }
  };

  useEffect(() => {
    const currentProps = callbacksRef.current;
    const nextHomeView = readTwinDashboardHomeView(window.location.search);
    setHomeViewState(nextHomeView);
    writeTwinDashboardHomeView(nextHomeView, "replace");
    setMeaningfulQueryState(twinDashboardQueryHasMeaningfulSelection(
      window.location.search,
      optionsRef.current,
    ));
    const next = readTwinDashboardQuerySelection(
      window.location.search,
      optionsRef.current,
      selectionFromProps(currentProps, rangeRef.current),
    );
    applySelection(next);
    writeTwinDashboardQuerySelection(next, optionsRef.current, "replace");
  }, [scopeKey]);

  useEffect(() => {
    const expectedPathname = window.location.pathname;
    const restoreSelection = () => {
      if (window.location.pathname !== expectedPathname) return;
      const nextHomeView = readTwinDashboardHomeView(window.location.search);
      setHomeViewState(nextHomeView);
      writeTwinDashboardHomeView(nextHomeView, "replace");
      setMeaningfulQueryState(twinDashboardQueryHasMeaningfulSelection(
        window.location.search,
        optionsRef.current,
      ));
      const next = readTwinDashboardQuerySelection(window.location.search, optionsRef.current);
      applySelection(next);
      writeTwinDashboardQuerySelection(next, optionsRef.current, "replace");
    };
    window.addEventListener("popstate", restoreSelection);
    return () => window.removeEventListener("popstate", restoreSelection);
  }, [scopeKey]);

  const updateSelection = (next: TwinDashboardQuerySelection) => {
    selectionRef.current = next;
    writeTwinDashboardQuerySelection(next, optionsRef.current, "push");
  };
  const queryProps: TwinDashboardProps = {
    ...props,
    onFloor: (floorId) => {
      const previousSensorId = selectionRef.current.selectedSensorId;
      const next = selectionWithFloor(selectionRef.current, floorId, optionsRef.current);
      updateSelection(next);
      props.onFloor(floorId);
      if (next.selectedSensorId !== previousSensorId) props.onSensorSelect(next.selectedSensorId);
    },
    onMetric: (metric) => {
      updateSelection({ ...selectionRef.current, metric });
      props.onMetric(metric);
    },
    onViewMode: (viewMode) => {
      updateSelection({ ...selectionRef.current, viewMode });
      props.onViewMode(viewMode);
    },
    onSensorSelect: (selectedSensorId) => {
      updateSelection({ ...selectionRef.current, selectedSensorId });
      props.onSensorSelect(selectedSensorId);
    },
  };
  const setRange = (next: TimeRange) => {
    rangeRef.current = next;
    updateSelection({ ...selectionRef.current, range: next });
    setRangeState(next);
  };

  const setHomeView = (next: TwinDashboardHomeView, mode: "push" | "replace" = "push") => {
    setHomeViewState(next);
    writeTwinDashboardHomeView(next, mode);
  };

  return { props: queryProps, range, setRange, meaningfulQueryState, homeView, setHomeView };
}

export function TwinDashboard(props: TwinDashboardProps) {
  const context0 = useTwinDashboardQueryState(props);
  const context1 = useTwinDashboardPart01(context0);
  const context2 = useTwinDashboardPart02(context1);
  const context3 = useTwinDashboardPart03(context2);
  const context4 = useTwinDashboardPart04(context3);
  const context5 = useTwinDashboardPart05(context4);
  return renderTwinDashboard(context5);
}
