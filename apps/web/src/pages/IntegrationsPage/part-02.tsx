import { useEffect, useMemo } from "react";
import { floorMetersPerPlanUnit } from "@climate-twin/contracts";
import type {
  HouseLocation,
  HouseMapPlacement,
} from "@climate-twin/contracts";
import { api, errorMessage } from "../../api";
import type { HouseLocationMapItem } from "../../components/HouseLocationMap";
import { confirmAction } from "../../components/ConfirmationProvider";
import { floorPlanSize, footprintFloorFor, mapLocation, placementForm, setupSectionFromPath, validTimeZone, writeSetupSection } from "./support";
import { useIntegrationsPagePart01 } from "./part-01";
export function useIntegrationsPagePart02(context: ReturnType<typeof useIntegrationsPagePart01>) {
  const { houses, connectionHouses, onHouse, onIntegrationChange, onDisconnectHomeAssistant, t, setSetupHouseId, house, setActiveSection, setTesting, setResult, homeAssistantTestGeneration, discoveryGeneration, inventoryRefreshGeneration, historyExportRequestGeneration, setTestingDirect, setDirectResult, tpLinkTestGeneration, setValidatedTpLinkDraft, setDiscovering, setDiscovery, setDiscoveryOutcome, tpLinkHost, setTpLinkHost, tpLinkHostDraft, tpLinkUsername, setTpLinkUsername, tpLinkPassword, setTpLinkPassword, setReuseSavedTpLinkAccount, setShowTpLinkPassword, setSavingTpLink, setTpLinkFeedback, setRefreshingTpLinkInventory, setTpLinkInventoryRefreshFailed, tpLinkChildDiscoveryAbort, tpLinkChildDiscoveryKey, tpLinkChildDiscoveryRunning, haUrl, setHaUrl, haToken, setHaToken, setShowHaToken, setSavingHomeAssistant, setHomeAssistantFeedback, setBusyAssignment, setAssignmentFeedback, setValidatedHomeAssistantDraft, latitude, setLatitude, longitude, setLongitude, locationLabel, setLocationLabel, timezone, setTimezone, locationValidationAttempted, setLocationValidationAttempted, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, footprintFloorId, setFootprintFloorId, footprintWidthMeters, setFootprintWidthMeters, setPlacementEditing, setMapViewport, orientation, setOrientation, setSavingLocation, setLocationFeedback, setSavingPlacement, setPlacementFeedback, locationRequestGeneration, placementRequestGeneration, stopTpLinkChildDiscovery } = context;
  useEffect(() => {
      const restoreSection = () => setActiveSection(setupSectionFromPath());
      window.addEventListener("popstate", restoreSection);
      writeSetupSection(setupSectionFromPath(), true);
      return () => window.removeEventListener("popstate", restoreSection);
    }, []);
  useEffect(() => () => {
      historyExportRequestGeneration.current += 1;
      tpLinkChildDiscoveryAbort.current?.abort();
      tpLinkChildDiscoveryAbort.current = null;
      tpLinkChildDiscoveryKey.current = null;
      tpLinkChildDiscoveryRunning.current = false;
    }, []);
  useEffect(() => {
      setLatitude(house.location ? String(house.location.latitude) : "");
      setLongitude(house.location ? String(house.location.longitude) : "");
      setLocationLabel(house.location?.label ?? "");
      setTimezone(house.timezone);
    }, [house.id, house.location?.label, house.location?.latitude, house.location?.longitude, house.timezone]);
  useEffect(() => {
      const form = placementForm(house);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setPlacementEditing(!house.mapPlacement);
      setPlacementFeedback(null);
      setMapViewport(houses.some((candidate) => candidate.id !== house.id && (candidate.mapPlacement || candidate.location)) ? "all" : "selected");
    }, [house, houses]);
  useEffect(() => {
      setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
    }, [house.id, house.orientationDegrees]);
  useEffect(() => {
      locationRequestGeneration.current += 1;
      placementRequestGeneration.current += 1;
      tpLinkTestGeneration.current += 1;
      homeAssistantTestGeneration.current += 1;
      discoveryGeneration.current += 1;
      inventoryRefreshGeneration.current += 1;
      stopTpLinkChildDiscovery(true);
      setDiscovering(false);
      setDiscovery(null);
      setDiscoveryOutcome("idle");
      setRefreshingTpLinkInventory(false);
      setTpLinkInventoryRefreshFailed(false);
      setSavingLocation(false);
      setSavingPlacement(false);
      setSavingTpLink(false);
      setSavingHomeAssistant(false);
      setLocationFeedback(null);
      setPlacementFeedback(null);
      setLocationValidationAttempted(false);
      tpLinkHostDraft.current = "";
      context.tpLinkEditingConnectionId.current = null;
      setTpLinkHost("");
      setTpLinkUsername("");
      setTpLinkPassword("");
      setReuseSavedTpLinkAccount(true);
      setShowTpLinkPassword(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
      setTpLinkFeedback(null);
      setHaUrl("");
      setHaToken("");
      setShowHaToken(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
      setHomeAssistantFeedback(null);
    }, [house.id]);
  const tpLinkDraftKey = `${tpLinkHost.trim()}\u0000${tpLinkUsername.trim()}\u0000${tpLinkPassword}`;
  const homeAssistantDraftKey = `${haUrl.trim()}\u0000${haToken}`;
  useEffect(() => {
      tpLinkTestGeneration.current += 1;
      setTestingDirect(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
    }, [tpLinkHost, tpLinkUsername, tpLinkPassword]);
  useEffect(() => {
      homeAssistantTestGeneration.current += 1;
      setTesting(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
    }, [haUrl, haToken]);
  const changeTpLinkDraft = (field: "host" | "username" | "password", value: string) => {
      // Invalidate synchronously in the input event. A passive effect alone can
      // lose a race to a connection test promise that settles in the same turn.
      tpLinkTestGeneration.current += 1;
      setTestingDirect(false);
      setValidatedTpLinkDraft(null);
      setDirectResult(null);
      if (field === "host") {
        tpLinkHostDraft.current = value;
        setTpLinkHost(value);
        setReuseSavedTpLinkAccount(true);
      }
      else if (field === "username") setTpLinkUsername(value);
      else setTpLinkPassword(value);
    };
  const changeHomeAssistantDraft = (field: "url" | "token", value: string) => {
      homeAssistantTestGeneration.current += 1;
      setTesting(false);
      setValidatedHomeAssistantDraft(null);
      setResult(null);
      if (field === "url") setHaUrl(value);
      else setHaToken(value);
    };
  const draftLocation = useMemo<HouseLocation | null>(() => {
      if (!latitude.trim() || !longitude.trim()) return null;
      const parsedLatitude = Number(latitude);
      const parsedLongitude = Number(longitude);
      if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)
        || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
      const label = locationLabel.trim();
      return { latitude: parsedLatitude, longitude: parsedLongitude, ...(label ? { label } : {}) };
    }, [latitude, locationLabel, longitude]);
  const coordinateValidationVisible = !draftLocation
      && (locationValidationAttempted || Boolean(latitude.trim() || longitude.trim()));
  const timezoneValidationVisible = !validTimeZone(timezone)
      && (locationValidationAttempted || Boolean(timezone.trim()));
  const selectedFootprintFloor = useMemo(
      () => house.floors.find((floor) => floor.id === footprintFloorId) ?? footprintFloorFor(house),
      [footprintFloorId, house],
    );
  const selectedPlanSize = useMemo(() => floorPlanSize(selectedFootprintFloor), [selectedFootprintFloor]);
  const draftMapLocation = useMemo(
      () => mapLocation(placementLatitude, placementLongitude),
      [placementLatitude, placementLongitude],
    );
  const draftPlacement = useMemo<HouseMapPlacement | null>(() => {
      if (!draftMapLocation) return null;
      const physicalWidth = Number(footprintWidthMeters);
      if (!Number.isFinite(physicalWidth) || physicalWidth < 1 || physicalWidth > 500) return null;
      const metersPerPlanUnit = physicalWidth / selectedPlanSize.width;
      if (!Number.isFinite(metersPerPlanUnit) || metersPerPlanUnit <= 0) return null;
      return {
        ...draftMapLocation,
        metersPerPlanUnit,
        ...(selectedFootprintFloor ? { footprintFloorId: selectedFootprintFloor.id } : {}),
      };
    }, [draftMapLocation, footprintWidthMeters, selectedFootprintFloor, selectedPlanSize.width]);
  const draftOrientation = useMemo<number | null>(() => {
      if (!orientation.trim()) return null;
      const parsed = Number(orientation);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 359 ? parsed : null;
    }, [orientation]);
  const footprintDepthMeters = useMemo(() => {
      const physicalWidth = Number(footprintWidthMeters);
      return Number.isFinite(physicalWidth) && selectedPlanSize.width > 0
        ? physicalWidth * selectedPlanSize.depth / selectedPlanSize.width
        : null;
    }, [footprintWidthMeters, selectedPlanSize]);
  const mapItems = useMemo<HouseLocationMapItem[]>(() => houses.map((candidate) => {
      const selected = candidate.id === house.id;
      const placement = selected ? draftPlacement : candidate.mapPlacement;
      const fallback = selected ? draftMapLocation : candidate.mapPlacement ?? candidate.location ?? null;
      const floor = selected
        ? selectedFootprintFloor
        : candidate.floors.find((item) => item.id === candidate.mapPlacement?.footprintFloorId) ?? footprintFloorFor(candidate);
      const resolvedScale = selected
        ? placement?.metersPerPlanUnit
        : floor ? floorMetersPerPlanUnit(floor, candidate) : null;
      const candidateOrientation = selected ? draftOrientation : candidate.orientationDegrees;
      return {
        id: candidate.id,
        label: t("weather.markerLabel", { house: candidate.name }),
        location: fallback ? { latitude: fallback.latitude, longitude: fallback.longitude } : null,
        ...(candidateOrientation !== null && candidateOrientation !== undefined ? { orientationDegrees: candidateOrientation } : {}),
        ...(resolvedScale !== null && resolvedScale !== undefined ? { metersPerPlanUnit: resolvedScale } : {}),
        ...(floor ? { floor } : {}),
      };
    }), [draftMapLocation, draftOrientation, draftPlacement, house.id, houses, selectedFootprintFloor, t]);
  const orientationDirection = draftOrientation === null
      ? null
      : [t("orientation.north"), t("orientation.east"), t("orientation.south"), t("orientation.west")][Math.round(draftOrientation / 90) % 4];
  const orientationExplanation = draftOrientation === null
      ? t("orientation.unknownExplanation")
      : t("orientation.knownExplanation", { degrees: draftOrientation, direction: orientationDirection ?? "" });
  const selectSetupHouse = (houseId: string) => {
      if (houseId !== house.id) {
        locationRequestGeneration.current += 1;
        placementRequestGeneration.current += 1;
        discoveryGeneration.current += 1;
        inventoryRefreshGeneration.current += 1;
        stopTpLinkChildDiscovery(true);
        setSavingLocation(false);
        setSavingPlacement(false);
        setDiscovering(false);
        setRefreshingTpLinkInventory(false);
      }
      setSetupHouseId(houseId);
      onHouse(houseId);
    };
  const disconnectHomeAssistantAssignment = async (houseId: string) => {
      const assignedHouse = connectionHouses.find((candidate) => candidate.id === houseId);
      if (!await confirmAction(t("setup.disconnectHomeAssistantConfirm", { home: assignedHouse?.name ?? houseId }), t("confirmation.disconnect"))) return;
      const assignmentKey = `ha:${houseId}`;
      setBusyAssignment(assignmentKey);
      setAssignmentFeedback(null);
      try {
        const result = await (onDisconnectHomeAssistant
          ? onDisconnectHomeAssistant(houseId)
          : api.disconnectHomeAssistant(houseId));
        onIntegrationChange(result.integration);
        setAssignmentFeedback({ kind: "success", message: t("setup.connectionDisconnected") });
      } catch (error) {
        setAssignmentFeedback({ kind: "error", message: errorMessage(error, t("setup.connectionDisconnectFailed")) });
      } finally {
        setBusyAssignment((current) => current === assignmentKey ? null : current);
      }
    };
  return Object.assign(context, { tpLinkDraftKey, homeAssistantDraftKey, changeTpLinkDraft, changeHomeAssistantDraft, draftLocation, coordinateValidationVisible, timezoneValidationVisible, selectedFootprintFloor, selectedPlanSize, draftMapLocation, draftPlacement, draftOrientation, footprintDepthMeters, mapItems, orientationDirection, orientationExplanation, selectSetupHouse, disconnectHomeAssistantAssignment });
}
