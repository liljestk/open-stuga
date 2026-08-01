import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Lightbulb,
  LoaderCircle,
  PlugZap,
  Power,
  RadioTower,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  ConnectedDeviceColor,
  ConnectedDeviceState,
  House,
  IntegrationStatus,
  TuyaDiscoveredDevice,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import { formatInTimeZone } from "../../dateTime";
import { useConnectedDevicesQuery } from "../../data/connectedDevicesQuery";
import { useI18n } from "../../i18n";

interface TuyaSetupPanelProps {
  house: House;
  integration: IntegrationStatus;
  onIntegrationChange(integration: IntegrationStatus): void;
}

function rgbToHsv(hex: string): ConnectedDeviceColor {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {
    hue: Math.round((hue + 360) % 360),
    saturation: maximum === 0 ? 0 : Math.round(delta / maximum * 100),
    value: Math.max(1, Math.round(maximum * 100)),
  };
}

function hsvToHex(color: ConnectedDeviceColor | null): string {
  if (!color) return "#ffd7a0";
  const saturation = color.saturation / 100;
  const value = color.value / 100;
  const chroma = value * saturation;
  const segment = color.hue / 60;
  const second = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, second, 0]
    : segment < 2 ? [second, chroma, 0]
      : segment < 3 ? [0, chroma, second]
        : segment < 4 ? [0, second, chroma]
          : segment < 5 ? [second, 0, chroma] : [chroma, 0, second];
  const offset = value - chroma;
  return `#${[red, green, blue].map((channel) => (
    Math.round((channel + offset) * 255).toString(16).padStart(2, "0")
  )).join("")}`;
}

function DeviceIcon({ kind }: { kind: ConnectedDeviceState["kind"] }) {
  return kind === "light"
    ? <Lightbulb size={20} />
    : kind === "outlet" ? <PlugZap size={20} /> : <Power size={20} />;
}

function TuyaDeviceCard({
  house,
  connection,
  initialState,
  busy,
  onBusy,
  onState,
  onDisconnect,
}: {
  house: House;
  connection: NonNullable<IntegrationStatus["tuya"]>["connections"][number];
  initialState: ConnectedDeviceState | undefined;
  busy: boolean;
  onBusy(value: boolean): void;
  onState(state: ConnectedDeviceState): void;
  onDisconnect(): void;
}) {
  const { locale, t } = useI18n();
  const [state, setState] = useState(initialState);
  const [brightness, setBrightness] = useState(initialState?.brightnessPercent ?? 100);
  const [temperature, setTemperature] = useState(initialState?.colorTemperatureKelvin ?? 4_000);
  const [color, setColor] = useState(() => hsvToHex(initialState?.color ?? null));
  const [lightMode, setLightMode] = useState<"white" | "colour">(
    initialState?.workMode === "colour" ? "colour" : "white",
  );
  const [floorId, setFloorId] = useState(initialState?.floorId ?? house.floors[0]?.id ?? "");
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setState(initialState);
    if (initialState?.brightnessPercent != null) setBrightness(initialState.brightnessPercent);
    if (initialState?.colorTemperatureKelvin != null) setTemperature(initialState.colorTemperatureKelvin);
    if (initialState?.color) setColor(hsvToHex(initialState.color));
  }, [initialState]);

  const run = async (change: Omit<Parameters<typeof api.commandConnectedDevice>[1], "operationId">) => {
    onBusy(true);
    setFeedback(null);
    try {
      const result = await api.commandConnectedDevice(connection.id, {
        operationId: crypto.randomUUID(),
        ...change,
      });
      setState(result.state);
      onState(result.state);
    } catch {
      setFeedback({ kind: "error", text: t("setup.tuyaCommandFailed") });
    } finally {
      onBusy(false);
    }
  };

  const applyLight = async (event: FormEvent) => {
    event.preventDefault();
    if (lightMode === "colour") await run({ color: rgbToHsv(color) });
    else await run({
      ...(connection.capabilities.brightness ? { brightnessPercent: brightness } : {}),
      ...(connection.capabilities.colorTemperature ? { colorTemperatureKelvin: temperature } : {}),
    });
  };

  const place = async () => {
    const floor = house.floors.find((candidate) => candidate.id === floorId);
    if (!floor) return;
    onBusy(true);
    setFeedback(null);
    try {
      const result = await api.placeConnectedDevice(connection.id, {
        floorId,
        roomId: null,
        x: floor.width / 2,
        y: floor.height / 2,
        z: floor.elevation + 1.2,
      });
      if (result.state) {
        setState(result.state);
        onState(result.state);
      }
      setFeedback({ kind: "success", text: t("setup.tuyaPlacementSaved") });
    } catch {
      setFeedback({ kind: "error", text: t("setup.tuyaPlacementFailed") });
    } finally {
      onBusy(false);
    }
  };

  const connected = connection.connected && state?.available;
  return <details className={`connection-source-card ${connection.error ? "attention" : ""}`} open>
    <summary className="connection-source-card-heading">
      <span className="connection-source-icon" aria-hidden="true"><DeviceIcon kind={connection.kind} /></span>
      <span className="connection-source-title">
        <small>{t("setup.tuyaDevice")}</small><strong>{connection.name}</strong>
        {connection.model && <span>{connection.model}</span>}
      </span>
      <span className={`source-health-pill ${connected ? "connected" : connection.error ? "error" : "reconnecting"}`} role="status">
        <span aria-hidden="true" />{t(connected
          ? "setup.tuyaConnected" : connection.error ? "setup.tuyaUnavailable" : "setup.tuyaReconnecting")}
      </span>
    </summary>
    <div className="connection-source-card-content">
      <p className="connection-source-route">
        <RadioTower size={15} aria-hidden="true" /><span>{t("setup.tuyaLocalRuntime")}</span>
      </p>
      <dl className="connection-source-facts">
        <div><dt>{t("setup.tuyaPower")}</dt><dd>{state?.power == null
          ? t("common.noData") : t(state.power ? "common.on" : "common.off")}</dd></div>
        {connection.capabilities.brightness && <div><dt>{t("setup.tuyaBrightness")}</dt><dd>
          {state?.brightnessPercent == null ? t("common.noData") : `${Math.round(state.brightnessPercent)}%`}
        </dd></div>}
        {connection.capabilities.colorTemperature && <div><dt>{t("setup.tuyaTemperature")}</dt><dd>
          {state?.colorTemperatureKelvin == null ? t("common.noData") : `${Math.round(state.colorTemperatureKelvin)} K`}
        </dd></div>}
        <div><dt>{t("setup.sourceLastUpdate")}</dt><dd>{connection.lastPollAt
          ? <time dateTime={connection.lastPollAt}>{formatInTimeZone(
              new Date(connection.lastPollAt), locale, house.timezone,
              { dateStyle: "short", timeStyle: "short" },
            )}</time>
          : t("common.noData")}</dd></div>
      </dl>

      <button
        type="button"
        className="primary-button full-width"
        disabled={busy || !connected || state?.power == null}
        aria-pressed={state?.power ?? undefined}
        onClick={() => void run({ power: !state?.power })}
      >
        {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}
        {t(state?.power ? "setup.tuyaTurnOff" : "setup.tuyaTurnOn")}
      </button>

      {(connection.capabilities.brightness || connection.capabilities.colorTemperature || connection.capabilities.color)
        && <details className="advanced-setup tuya-device-settings">
          <summary>{t("setup.tuyaLightSettings")}</summary>
          <form onSubmit={(event) => void applyLight(event)} className="tuya-light-form">
            {connection.capabilities.color && <fieldset className="tuya-mode-choice">
              <legend>{t("setup.tuyaLightMode")}</legend>
              <label><input type="radio" checked={lightMode === "white"} onChange={() => setLightMode("white")} />{t("setup.tuyaWhite")}</label>
              <label><input type="radio" checked={lightMode === "colour"} onChange={() => setLightMode("colour")} />{t("setup.tuyaColour")}</label>
            </fieldset>}
            {lightMode === "white" && connection.capabilities.brightness && <label>
              <span>{t("setup.tuyaBrightness")} <output>{Math.round(brightness)}%</output></span>
              <input type="range" min="1" max="100" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} />
            </label>}
            {lightMode === "white" && connection.capabilities.colorTemperature && <label>
              <span>{t("setup.tuyaTemperature")} <output>{Math.round(temperature)} K</output></span>
              <input type="range" min="2700" max="6500" step="100" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
            </label>}
            {lightMode === "colour" && connection.capabilities.color && <label>
              <span>{t("setup.tuyaColour")}</span>
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
            </label>}
            <button type="submit" className="secondary-button" disabled={busy || !connected}>
              <Save size={14} aria-hidden="true" />{t("setup.tuyaApplySettings")}
            </button>
          </form>
        </details>}

      <details className="advanced-setup tuya-device-settings">
        <summary>{t("setup.tuyaPlacement")}</summary>
        <div className="tuya-placement-form">
          <label><span>{t("setup.tuyaFloor")}</span><select value={floorId} onChange={(event) => setFloorId(event.target.value)}>
            {house.floors.map((floor) => <option value={floor.id} key={floor.id}>{floor.name}</option>)}
          </select></label>
          <button type="button" className="secondary-button" disabled={busy || !floorId} onClick={() => void place()}>
            <Save size={14} aria-hidden="true" />{t("setup.tuyaPlace")}
          </button>
        </div>
      </details>

      <p className="setup-help">{connection.capabilities.measuredPower
        ? t("setup.tuyaEnergyAvailable") : t("setup.tuyaEnergyUnavailable")}</p>
      {connection.error && <p className="connection-source-error" role="alert">
        <TriangleAlert size={15} aria-hidden="true" /><span>{connection.error}</span>
      </p>}
      {feedback && <p className={`test-result ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
        {feedback.kind === "success" ? <Check size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
        {feedback.text}
      </p>}
      <button type="button" className="danger-button" disabled={busy} onClick={onDisconnect}>
        <Trash2 size={14} aria-hidden="true" />{t("setup.disconnect")}
      </button>
    </div>
  </details>;
}

export function TuyaSetupPanel({
  house,
  integration,
  onIntegrationChange,
}: TuyaSetupPanelProps) {
  const { t } = useI18n();
  const connections = integration.tuya?.connections ?? [];
  const [states, setStates] = useState<ConnectedDeviceState[]>([]);
  const [host, setHost] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [localKey, setLocalKey] = useState("");
  const [version, setVersion] = useState("3.3");
  const [networkSource, setNetworkSource] = useState<"discovered" | "manual" | null>(null);
  const [discoveredDevice, setDiscoveredDevice] = useState<TuyaDiscoveredDevice | null>(null);
  const [name, setName] = useState("");
  const [floorId, setFloorId] = useState(house.floors[0]?.id ?? "");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const setupGeneration = useRef(0);
  const statesQuery = useConnectedDevicesQuery(house.id, connections.length > 0);

  useEffect(() => {
    if (statesQuery.data) setStates(statesQuery.data);
  }, [statesQuery.data]);

  useEffect(() => {
    setupGeneration.current += 1;
    setStates([]);
    setHost("");
    setDeviceId("");
    setLocalKey("");
    setVersion("3.3");
    setNetworkSource(null);
    setDiscoveredDevice(null);
    setName("");
    setFloorId(house.floors[0]?.id ?? "");
    setBusyId(null);
    setFeedback(null);
  }, [house.id]);

  const resetNetworkDetails = () => {
    setupGeneration.current += 1;
    setHost("");
    setVersion("3.3");
    setNetworkSource(null);
    setDiscoveredDevice(null);
    setFeedback(null);
  };

  const changeDeviceId = (value: string) => {
    setDeviceId(value);
    resetNetworkDetails();
  };

  const changeLocalKey = (value: string) => {
    setLocalKey(value);
    resetNetworkDetails();
  };

  const discover = async () => {
    const generation = ++setupGeneration.current;
    setBusyId("discover");
    setFeedback(null);
    setNetworkSource(null);
    setDiscoveredDevice(null);
    setHost("");
    try {
      const [device] = await api.discoverTuya({
        houseId: house.id,
        deviceId: deviceId.trim(),
        localKey,
      });
      if (generation !== setupGeneration.current) return;
      if (!device) {
        setFeedback({ kind: "error", text: t("setup.tuyaDiscoveryEmpty") });
        return;
      }
      setHost(device.host);
      setVersion(device.protocolVersion);
      setDiscoveredDevice(device);
      setNetworkSource("discovered");
    } catch {
      if (generation === setupGeneration.current) {
        setFeedback({ kind: "error", text: t("setup.tuyaDiscoveryFailed") });
      }
    } finally {
      if (generation === setupGeneration.current) setBusyId(null);
    }
  };

  const useManualNetwork = () => {
    if (!host.trim()) return;
    setHost(host.trim());
    setDiscoveredDevice(null);
    setNetworkSource("manual");
    setFeedback(null);
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!networkSource) return;
    const generation = ++setupGeneration.current;
    setBusyId("new");
    setFeedback(null);
    try {
      const result = await api.configureTuya({
        houseId: house.id,
        host,
        deviceId,
        localKey,
        protocolVersion: version,
        ...(discoveredDevice?.productKey ? { productKey: discoveredDevice.productKey } : {}),
        ...(discoveredDevice?.mac ? { mac: discoveredDevice.mac } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(floorId ? { floorId } : {}),
      });
      if (generation !== setupGeneration.current) return;
      setStates((current) => [result.state, ...current.filter((state) => state.id !== result.state.id)]);
      setLocalKey("");
      setDeviceId("");
      setHost("");
      setVersion("3.3");
      setNetworkSource(null);
      setDiscoveredDevice(null);
      setName("");
      onIntegrationChange(result.integration);
      setFeedback({ kind: "success", text: t("setup.tuyaAdded") });
    } catch {
      if (generation === setupGeneration.current) {
        setFeedback({ kind: "error", text: t("setup.tuyaAddFailed") });
      }
    } finally {
      if (generation === setupGeneration.current) setBusyId(null);
    }
  };

  const disconnect = async (connectionId: string, deviceName: string) => {
    if (!await confirmAction(t("setup.tuyaDisconnectConfirm", { device: deviceName }), t("confirmation.disconnect"))) return;
    setBusyId(connectionId);
    setFeedback(null);
    try {
      const result = await api.disconnectTuya(connectionId);
      setStates((current) => current.filter((state) => state.connectionId !== connectionId));
      onIntegrationChange(result.integration);
      setFeedback({ kind: "success", text: t("setup.tuyaDisconnected") });
    } catch {
      setFeedback({ kind: "error", text: t("setup.tuyaDisconnectFailed") });
    } finally {
      setBusyId(null);
    }
  };

  return <section className="panel connection-card connection-provider tuya-setup-panel" aria-labelledby="tuya-connection-heading">
    <div className="panel-header">
      <div><span className="eyebrow">{t("setup.tuyaEyebrow")}</span><h2 id="tuya-connection-heading">{t("setup.tuyaTitle")}</h2></div>
      <span className="ha-mark" aria-hidden="true"><Lightbulb size={22} /></span>
    </div>
    <p className="connection-card-description">{t("setup.tuyaDescription")}</p>
    <p className="configured-note tuya-discovery-off"><RadioTower size={17} aria-hidden="true" />
      <span>{t("setup.tuyaDiscoveryOff")}</span>
    </p>

    {connections.length > 0 && <div className="connection-source-list">
      {connections.map((connection) => <TuyaDeviceCard
        key={connection.id}
        house={house}
        connection={connection}
        initialState={states.find((state) => state.connectionId === connection.id)}
        busy={busyId !== null}
        onBusy={(value) => setBusyId(value ? connection.id : null)}
        onState={(state) => setStates((current) => [
          state,
          ...current.filter((item) => item.connectionId !== state.connectionId),
        ])}
        onDisconnect={() => void disconnect(connection.id, connection.name)}
      />)}
    </div>}

    <details className="setup-config-disclosure tuya-add-device">
      <summary><span><PlugZap size={16} aria-hidden="true" />{t("setup.tuyaManualTitle")}</span>
        <small>{t("setup.tuyaManualHelp")}</small></summary>
      <form onSubmit={(event) => void add(event)} className="guided-setup tuya-setup-form">
        <label><span>{t("setup.tuyaDeviceId")}</span><input required autoComplete="off" maxLength={200} value={deviceId}
          disabled={busyId !== null || networkSource !== null} onChange={(event) => changeDeviceId(event.target.value)} /></label>
        <label><span>{t("setup.tuyaLocalKey")}</span><input required type="password" autoComplete="new-password" maxLength={256} value={localKey}
          disabled={busyId !== null || networkSource !== null} onChange={(event) => changeLocalKey(event.target.value)} /></label>
        <p className="setup-help">{t("setup.tuyaDiscoveryScope")}</p>

        {!networkSource && <>
          <button type="button" className="primary-button full-width"
            disabled={busyId !== null || !deviceId.trim() || !localKey.trim()}
            onClick={() => void discover()}>
            {busyId === "discover" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RadioTower size={16} aria-hidden="true" />}
            {t(busyId === "discover" ? "setup.tuyaDiscovering" : "setup.tuyaEnableDiscovery")}
          </button>
          <details className="advanced-setup tuya-manual-network">
            <summary>{t("setup.tuyaManualNetworkTitle")}</summary>
            <div className="tuya-manual-network-fields">
              <p className="setup-help">{t("setup.tuyaManualNetworkHelp")}</p>
              <label><span>{t("setup.tuyaHost")}</span><input required inputMode="decimal" value={host}
                disabled={busyId !== null} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.50" /></label>
              <label><span>{t("setup.tuyaVersion")}</span><select value={version} disabled={busyId !== null}
                onChange={(event) => setVersion(event.target.value)}>
                {["3.1", "3.2", "3.3", "3.4", "3.5"].map((candidate) => <option key={candidate}>{candidate}</option>)}
              </select></label>
              <button type="button" className="secondary-button" disabled={busyId !== null || !host.trim() || !deviceId.trim() || !localKey.trim()}
                onClick={useManualNetwork}>{t("setup.tuyaUseManualNetwork")}</button>
            </div>
          </details>
        </>}

        {networkSource && <>
          <p className="tuya-network-result" role="status"><Check size={17} aria-hidden="true" /><span>
            {t(networkSource === "discovered" ? "setup.tuyaDiscoveryFound" : "setup.tuyaManualReady", { host, version })}
          </span></p>
          <label><span>{t("setup.tuyaName")}</span><input value={name} maxLength={200} disabled={busyId !== null}
            onChange={(event) => setName(event.target.value)} /></label>
          <label><span>{t("setup.tuyaFloor")}</span><select value={floorId} disabled={busyId !== null}
            onChange={(event) => setFloorId(event.target.value)}>
            <option value="">{t("setup.tuyaUnplaced")}</option>
            {house.floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}
          </select></label>
          <p className="setup-help">{t("setup.tuyaKeyHelp")}</p>
          <div className="tuya-finish-actions">
            <button type="submit" className="primary-button full-width" disabled={busyId !== null}>
              {busyId === "new" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {t(busyId === "new" ? "setup.tuyaAdding" : "setup.tuyaAdd")}
            </button>
            <button type="button" className="secondary-button" disabled={busyId !== null} onClick={() => resetNetworkDetails()}>
              {t("setup.tuyaChangeNetwork")}
            </button>
          </div>
        </>}
      </form>
    </details>

    {feedback && <p className={`test-result ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"} aria-live="polite">
      {feedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}
      {feedback.text}
    </p>}
  </section>;
}
