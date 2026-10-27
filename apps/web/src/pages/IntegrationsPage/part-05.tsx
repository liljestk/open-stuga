import {
  Home,
  Link2,
  ThermometerSun,
} from "lucide-react";
import type {
  HouseLocation,
  IntegrationStatus,
} from "@climate-twin/contracts";
import {
  api,
  type HouseGeoreferencePatch,
} from "../../api";
import type { MapLocation } from "../../components/HouseLocationMap";
import { type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";
import { placementForm, writeSetupSection } from "./support";
import type { SetupSection } from "./support";
import { useIntegrationsPagePart04 } from "./part-04";

type Translate = ReturnType<typeof useI18n>["t"];
type TpLinkHealthState = "connected" | "warning" | "error" | "reconnecting";

function connectedSourceLabelFor(
  integration: IntegrationStatus,
  connectedSourceCount: number,
  greeConnected: boolean,
  t: Translate,
): string {
  if (connectedSourceCount > 1) return t("setup.sourcesConnected", { count: connectedSourceCount });
  if (integration.tpLink.connected) return t("setup.tpLinkConnectedShort");
  if (integration.homeAssistant.connected) return t("setup.homeAssistantConnectedShort");
  return greeConnected ? t("setup.greeConnectedShort") : t("common.notConnected");
}

function tpLinkHealthStateFor(tpLink: IntegrationStatus["tpLink"]): TpLinkHealthState {
  if (tpLink.error) return tpLink.connected ? "warning" : "error";
  return tpLink.connected ? "connected" : "reconnecting";
}

function tpLinkHealthLabelFor(state: TpLinkHealthState, t: Translate): string {
  if (state === "connected") return t("common.connected");
  return state === "warning" ? t("setup.tpLinkWarning") : t("common.notConnected");
}

function setupSectionHeading(activeSection: SetupSection, activeSectionLabel: string, t: Translate): string {
  if (activeSection === "overview") return t("setup.title");
  if (activeSection === "connections") return t("setup.connectionsTitle");
  return activeSection === "weather" ? t("setup.workspaceWeather") : activeSectionLabel;
}

function setupSectionDescription(activeSection: SetupSection, t: Translate): string {
  if (activeSection === "connections") return t("setup.connectionsDescription");
  return activeSection === "weather" ? t("placement.weatherDescription") : t("setup.description");
}

export function useIntegrationsPagePart05(context: ReturnType<typeof useIntegrationsPagePart04>) {
  const { houses, streamConnection, onHouseUpdate, onGeoreferenceChange, t, house, integration, activeSection, setActiveSection, discovery, tpLinkHost, haUrl, setLatitude, setLongitude, setLocationLabel, setTimezone, setPlacementLatitude, setPlacementLongitude, setFootprintFloorId, setFootprintWidthMeters, setPlacementEditing, orientation, setOrientation, setSavingLocation, setLocationFeedback, setSavingPlacement, setPlacementFeedback, homeAssistantAssignments, tpLinkAssignments, beginLocationRequest, isCurrentLocationRequest, beginPlacementRequest, isCurrentPlacementRequest, draftMapLocation, draftPlacement, draftOrientation } = context;
  const resetPlacementDraft = () => {
      const form = placementForm(house);
      setPlacementLatitude(form.latitude);
      setPlacementLongitude(form.longitude);
      setFootprintFloorId(form.footprintFloorId);
      setFootprintWidthMeters(form.footprintWidthMeters);
      setOrientation(house.orientationDegrees === undefined ? "" : String(house.orientationDegrees));
      setPlacementEditing(false);
      setPlacementFeedback(null);
    };
  const savePlacement = async () => {
      if (!draftPlacement) {
        setPlacementFeedback({ kind: "error", message: t("placement.invalid") });
        return;
      }
      if (orientation.trim() && draftOrientation === null) {
        setPlacementFeedback({ kind: "error", message: t("orientation.invalid") });
        return;
      }
      const patch: HouseGeoreferencePatch = {
        mapPlacement: draftPlacement,
        ...(orientation.trim()
          ? { orientationDegrees: draftOrientation as number }
          : house.orientationDegrees !== undefined ? { orientationDegrees: null } : {}),
      };
      const request = beginPlacementRequest();
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, patch);
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementEditing(false);
        setPlacementFeedback({ kind: "success", message: t("placement.saved") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const removePlacement = async () => {
      const request = beginPlacementRequest();
      const selectedHouse = house;
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, { mapPlacement: null });
        if (!isCurrentPlacementRequest(request)) return;
        const { mapPlacement: _removedPlacement, ...houseWithoutPlacement } = selectedHouse;
        const form = placementForm(houseWithoutPlacement);
        setPlacementLatitude(form.latitude);
        setPlacementLongitude(form.longitude);
        setFootprintFloorId(form.footprintFloorId);
        setFootprintWidthMeters(form.footprintWidthMeters);
        setPlacementEditing(true);
        setPlacementFeedback({ kind: "success", message: t("placement.removed") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("placement.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const clearOrientation = async () => {
      const request = beginPlacementRequest();
      setSavingPlacement(true);
      setPlacementFeedback(null);
      try {
        await onGeoreferenceChange(request.houseId, { orientationDegrees: null });
        if (!isCurrentPlacementRequest(request)) return;
        setOrientation("");
        setPlacementFeedback({ kind: "success", message: t("orientation.cleared") });
      } catch {
        if (!isCurrentPlacementRequest(request)) return;
        setPlacementFeedback({ kind: "error", message: t("orientation.saveError") });
      } finally {
        if (isCurrentPlacementRequest(request)) setSavingPlacement(false);
      }
    };
  const updateFromMap = (houseId: string, location: MapLocation) => {
      if (houseId !== house.id) return;
      setPlacementLatitude(location.latitude.toFixed(7));
      setPlacementLongitude(location.longitude.toFixed(7));
      setPlacementEditing(true);
      setPlacementFeedback(null);
    };
  const usePlacementForWeather = () => {
      const source = house.mapPlacement ?? draftMapLocation;
      if (!source) return;
      setLatitude(source.latitude.toFixed(6));
      setLongitude(source.longitude.toFixed(6));
      setLocationLabel("");
      setLocationFeedback(null);
    };
  const savePlacementForWeather = async () => {
      const source = house.mapPlacement;
      if (!source) return;
      const request = beginLocationRequest();
      const discoveredAt = new Date().toISOString();
      const nextLocation: HouseLocation = {
        latitude: source.latitude,
        longitude: source.longitude,
        source: "map-placement",
        confidence: "high",
        discoveredAt,
        userOverridden: true,
      };
      setSavingLocation(true);
      setLocationFeedback(null);
      try {
        const defaults = await api.coordinateDefaults(source.latitude, source.longitude);
        await onHouseUpdate(request.houseId, { location: nextLocation, timezone: defaults.timezone });
        if (!isCurrentLocationRequest(request)) return;
        setLatitude(String(source.latitude));
        setLongitude(String(source.longitude));
        setLocationLabel("");
        setTimezone(defaults.timezone);
        setLocationFeedback({ kind: "success", message: t("weather.locationSaved") });
      } catch {
        if (!isCurrentLocationRequest(request)) return;
        setLocationFeedback({ kind: "error", message: t("weather.locationSaveError") });
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  const applyDiscoveredDefaults = async (defaults: DiscoveredHomeDefaults) => {
      const request = beginLocationRequest();
      setSavingLocation(true);
      try {
        await onHouseUpdate(request.houseId, { location: defaults.location, timezone: defaults.timezone });
        if (!isCurrentLocationRequest(request)) return;
        setLatitude(String(defaults.location.latitude));
        setLongitude(String(defaults.location.longitude));
        setLocationLabel(defaults.location.label ?? "");
        setTimezone(defaults.timezone);
        setLocationFeedback(null);
      } finally {
        if (isCurrentLocationRequest(request)) setSavingLocation(false);
      }
    };
  const addableTpLinkSources = (discovery?.tpLink ?? []).filter((source) => !source.configuredConnectionId);
  const addableGreeDevices = (discovery?.gree ?? []).filter((device) => !device.configuredConnectionId);
  const discoveredCount = addableTpLinkSources.length + addableGreeDevices.length
      + (discovery?.homeAssistant.length ?? 0);
  const sensorHardwareDetected = addableTpLinkSources.length + (discovery?.homeAssistant.length ?? 0) > 0
      || integration.tpLink.discoveredDevices > 0
      || integration.tpLink.mappedDevices > 0
      || integration.homeAssistant.mappedEntities > 0;
  const sensorSourceConfigured = integration.tpLink.configured || integration.homeAssistant.configured;
  const sensorSourceConnected = integration.tpLink.connected || integration.homeAssistant.connected;
  const mappedSensorSources = integration.tpLink.mappedDevices > 0 || integration.homeAssistant.mappedEntities > 0;
  const tpLinkReadyDevices = Math.max(0, integration.tpLink.discoveredDevices - integration.tpLink.mappedDevices);
  const tpLinkHubName = integration.tpLink.hubModel ?? t("setup.tpLinkEnergyDevice");
  const tpLinkSourceCount = integration.tpLink.connections?.length ?? Number(integration.tpLink.configured);
  const connectedTpLinkSourceCount = integration.tpLink.connections
    ? integration.tpLink.connections.filter((connection) => connection.connected).length
    : Number(integration.tpLink.connected);
  const greeConnected = integration.gree?.connected ?? false;
  const connectedSourceCount = Number(integration.tpLink.connected)
      + Number(integration.homeAssistant.connected)
      + Number(greeConnected);
  const assignmentCount = homeAssistantAssignments.length + tpLinkAssignments.length;
  const connectedSourceLabel = connectedSourceLabelFor(integration, connectedSourceCount, greeConnected, t);
  const streamStatusLabel = t(`setup.stream.${streamConnection}`);
  const tpLinkHealthState = tpLinkHealthStateFor(integration.tpLink);
  const tpLinkHealthLabel = tpLinkHealthLabelFor(tpLinkHealthState, t);
  const tpLinkStatusTitle = t("setup.tpLinkSourcesStatusTitle", {
      connected: connectedTpLinkSourceCount,
      count: tpLinkSourceCount,
    });
  const connectionWorkspaceActive = activeSection === "connections"
      && (sensorSourceConfigured || Boolean(integration.gree?.configured));
  const steps = [
      { icon: Home, title: t("setup.step1"), body: t("setup.step1body"), complete: true },
      { icon: Link2, title: t("setup.step2"), body: t("setup.step2body"), complete: sensorSourceConnected },
      { icon: ThermometerSun, title: t("setup.step3"), body: t("setup.step3body"), complete: mappedSensorSources },
    ];
  const completeCount = steps.filter((step) => step.complete).length;
  const nextStepIndex = steps.findIndex((step) => !step.complete);
  const nextStep = nextStepIndex >= 0 ? steps[nextStepIndex]! : null;
  const weatherHomes = houses.filter((candidate) => candidate.location).length;
  const notesGrantCount = integration.appleNotes?.grantCount ?? 0;
  const selectedDiscoveredTpLink = addableTpLinkSources.find((candidate) => candidate.host === tpLinkHost);
  const selectedDiscoveredHomeAssistant = discovery?.homeAssistant.find((candidate) => candidate.url === haUrl);
  const setupSections: Array<{ id: SetupSection; label: string; detail: string }> = [
      { id: "overview", label: t("setup.workspaceOverview"), detail: t("setup.workspaceOverviewDetail") },
      { id: "layout", label: t("setup.workspaceLayout"), detail: t("setup.workspaceLayoutDetail", { count: house.floors.length }) },
      { id: "connections", label: t("setup.workspaceConnections"), detail: connectedSourceLabel },
      { id: "weather", label: t("setup.workspaceWeather"), detail: t("setup.workspaceWeatherDetail", { count: weatherHomes }) },
      { id: "operations", label: t("setup.workspaceOperations"), detail: t("setup.workspaceOperationsDetail") },
      { id: "automations", label: t("setup.workspaceAutomations"), detail: t("setup.workspaceAutomationsDetail", { count: notesGrantCount }) },
    ];
  const primarySetupSections = setupSections.filter((section) => section.id !== "weather" && section.id !== "operations" && section.id !== "automations");
  const advancedSetupSections = setupSections.filter((section) => section.id === "weather" || section.id === "operations" || section.id === "automations");
  const activeSectionLabel = setupSections.find((section) => section.id === activeSection)?.label ?? t("setup.workspaceOverview");
  const sectionHeading = setupSectionHeading(activeSection, activeSectionLabel, t);
  const sectionDescription = setupSectionDescription(activeSection, t);
  const activateSection = (section: SetupSection) => {
      setActiveSection(section);
      writeSetupSection(section);
    };
  return Object.assign(context, { resetPlacementDraft, savePlacement, removePlacement, clearOrientation, updateFromMap, usePlacementForWeather, savePlacementForWeather, applyDiscoveredDefaults, addableTpLinkSources, addableGreeDevices, discoveredCount, sensorHardwareDetected, sensorSourceConfigured, sensorSourceConnected, mappedSensorSources, tpLinkReadyDevices, tpLinkHubName, connectedSourceCount, assignmentCount, connectedSourceLabel, streamStatusLabel, tpLinkHealthState, tpLinkHealthLabel, tpLinkStatusTitle, connectionWorkspaceActive, steps, completeCount, nextStepIndex, nextStep, weatherHomes, notesGrantCount, selectedDiscoveredTpLink, selectedDiscoveredHomeAssistant, setupSections, primarySetupSections, advancedSetupSections, activeSectionLabel, sectionHeading, sectionDescription, activateSection });
}
