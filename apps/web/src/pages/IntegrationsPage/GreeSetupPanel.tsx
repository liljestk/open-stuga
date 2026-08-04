import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  Cloud,
  LoaderCircle,
  Snowflake,
  Thermometer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  GreeDiscoveredDevice,
  HeatPumpMode,
  HeatPumpState,
  House,
  IntegrationStatus,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { confirmAction } from "../../components/ConfirmationProvider";
import { formatInTimeZone } from "../../dateTime";
import { useI18n } from "../../i18n";

interface GreeSetupPanelProps {
  house: House;
  integration: IntegrationStatus;
  devices: GreeDiscoveredDevice[];
  onIntegrationChange(integration: IntegrationStatus): void;
}

const modeKeys = {
  auto: "setup.greeModeAuto",
  cool: "setup.greeModeCool",
  dry: "setup.greeModeDry",
  fan: "setup.greeModeFan",
  heat: "setup.greeModeHeat",
} as const satisfies Record<HeatPumpMode, string>;

function deviceName(device: Pick<GreeDiscoveredDevice, "name" | "brand" | "model" | "mac">): string {
  const genericName = device.name && !/^[0-9a-f]{12}$/iu.test(device.name) ? device.name : null;
  return genericName ?? ([device.brand, device.model].filter(Boolean).join(" ") || "Gree/Wilfa");
}

export function GreeSetupPanel({
  house,
  integration,
  devices,
  onIntegrationChange,
}: GreeSetupPanelProps) {
  const { locale, t } = useI18n();
  const connections = integration.gree?.connections ?? [];
  const configuredMacs = useMemo(
    () => new Set(connections.map((connection) => connection.mac)),
    [connections],
  );
  const [autoDevices, setAutoDevices] = useState<GreeDiscoveredDevice[]>([]);
  const [cloudDevices, setCloudDevices] = useState<GreeDiscoveredDevice[]>([]);
  const [cloudUsername, setCloudUsername] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudPending, setCloudPending] = useState(false);
  const discoveredDevices = useMemo(
    () => [...new Map([...cloudDevices, ...autoDevices, ...devices].map((device) => [device.mac, device])).values()],
    [autoDevices, cloudDevices, devices],
  );
  const [handledMacs, setHandledMacs] = useState<Set<string>>(() => new Set());
  const addable = discoveredDevices.filter((device) => (
    !device.configuredConnectionId && !configuredMacs.has(device.mac) && !handledMacs.has(device.mac)
  ));
  const [states, setStates] = useState<HeatPumpState[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setAutoDevices([]);
    if (connections.length > 0) return;
    let active = true;
    void api.discoverGree(house.id).then((next) => {
      if (active) setAutoDevices(next);
    }).catch(() => {
      // Optional discovery is intentionally silent when no compatible unit is present.
    });
    return () => { active = false; };
  }, [house.id, connections.length]);

  useEffect(() => {
    if (connections.length === 0) {
      setStates([]);
      return;
    }
    let active = true;
    const load = () => {
      void api.heatPumpStates(house.id).then((next) => {
        if (active) setStates(next);
      }).catch(() => {
        // Connection health remains visible; a transient state read needs no extra panel.
      });
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [house.id, connections.length]);

  const add = async (device: GreeDiscoveredDevice) => {
    setBusyId(device.mac);
    setFeedback(null);
    try {
      const result = device.transport === "ewpe-cloud"
        ? await api.configureGreeCloud({
            houseId: house.id,
            mac: device.mac,
            username: cloudUsername,
            password: cloudPassword,
          })
        : await api.configureGree({ houseId: house.id, mac: device.mac });
      setStates((current) => [
        result.state,
        ...current.filter((state) => state.connectionId !== result.state.connectionId),
      ]);
      setHandledMacs((current) => new Set([...current, device.mac]));
      if (device.transport === "ewpe-cloud") {
        setCloudPassword("");
        setCloudDevices([]);
      }
      onIntegrationChange(result.integration);
      setFeedback({ kind: "success", text: t("setup.greeAdded", { device: deviceName(device) }) });
    } catch {
      setFeedback({ kind: "error", text: t("setup.greeAddFailed") });
    } finally {
      setBusyId(null);
    }
  };

  const discoverCloud = async (event: FormEvent) => {
    event.preventDefault();
    setCloudPending(true);
    setFeedback(null);
    try {
      const next = await api.discoverGreeCloud({
        houseId: house.id,
        username: cloudUsername,
        password: cloudPassword,
      });
      setCloudDevices(next);
      if (next.length === 0) setFeedback({ kind: "error", text: t("setup.greeCloudNone") });
    } catch {
      setCloudDevices([]);
      setFeedback({ kind: "error", text: t("setup.greeCloudFailed") });
    } finally {
      setCloudPending(false);
    }
  };

  const disconnect = async (id: string, name: string) => {
    if (!await confirmAction(t("setup.greeDisconnectConfirm", { device: name }), t("confirmation.disconnect"))) return;
    setBusyId(id);
    setFeedback(null);
    try {
      const result = await api.disconnectGree(id);
      setStates((current) => current.filter((state) => state.connectionId !== id));
      onIntegrationChange(result.integration);
      setFeedback({ kind: "success", text: t("setup.greeDisconnected", { device: name }) });
    } catch {
      setFeedback({ kind: "error", text: t("setup.greeDisconnectFailed") });
    } finally {
      setBusyId(null);
    }
  };

  const stateFor = (id: string) => states.find((state) => state.connectionId === id);
  const temperature = (value: number | null | undefined) => (
    value == null ? t("common.noData") : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} °C`
  );

  return (
    <section className="panel connection-card connection-provider" aria-labelledby="gree-connection-heading">
      <div className="panel-header">
        <div><span className="eyebrow">{t("setup.greeEyebrow")}</span><h2 id="gree-connection-heading">{t("setup.greeTitle")}</h2></div>
        <span className="ha-mark" aria-hidden="true"><Snowflake size={22} /></span>
      </div>
      <p className="connection-card-description">{t("setup.greeDescription")}</p>

      {connections.length > 0 && <div className="connection-source-list">
        {connections.map((connection) => {
          const state = stateFor(connection.id);
          const liveState = connection.connected && state?.available ? state : undefined;
          const name = deviceName(connection);
          const health = connection.connected ? "connected" : connection.error ? "error" : "reconnecting";
          return <details className={`connection-source-card ${connection.error ? "attention" : ""}`} key={connection.id} open>
            <summary className="connection-source-card-heading">
              <span className="connection-source-icon" aria-hidden="true"><Thermometer size={20} /></span>
              <span className="connection-source-title"><small>{t("setup.greeDevice")}</small><strong>{name}</strong>{connection.model && <span>{connection.model}</span>}</span>
              <span className={`source-health-pill ${health}`} role="status"><span aria-hidden="true" />{t(connection.connected
                ? "setup.greeConnected"
                : connection.error ? "setup.greeUnavailable" : "setup.greeReconnecting")}</span>
            </summary>
            <div className="connection-source-card-content">
              <p className="connection-source-route"><Snowflake size={15} aria-hidden="true" /><span>{t("setup.greeReadOnly")}</span></p>
              <dl className="connection-source-facts">
                <div><dt>{t("setup.greeConnection")}</dt><dd>{t(connection.transport === "ewpe-cloud" ? "setup.greeCloud" : "setup.greeLocal")}</dd></div>
                <div><dt>{t("setup.greePower")}</dt><dd>{liveState?.power == null ? t("common.noData") : t(liveState.power ? "setup.greeOn" : "setup.greeOff")}</dd></div>
                <div><dt>{t("setup.greeSelectedMode")}</dt><dd>{liveState?.selectedMode ? t(modeKeys[liveState.selectedMode]) : t("common.noData")}</dd></div>
                <div><dt>{t("setup.greeTarget")}</dt><dd>{temperature(liveState?.targetTemperatureC)}</dd></div>
                <div><dt>{t("setup.greeIndoor")}</dt><dd>{temperature(liveState?.currentTemperatureC)}</dd></div>
                <div><dt>{t("setup.greeCompressorFrequency")}</dt><dd>{liveState?.compressorFrequencyHz == null
                  ? t("common.noData")
                  : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(liveState.compressorFrequencyHz)} Hz`}</dd></div>
                <div><dt>{t("setup.greeActivity")}</dt><dd>{liveState?.activity === "off" ? t("setup.greeOff") : liveState ? t("setup.greeActivityUnknown") : t("common.noData")}</dd></div>
                <div><dt>{t("setup.sourceLastUpdate")}</dt><dd>{connection.lastPollAt
                  ? <time dateTime={connection.lastPollAt}>{formatInTimeZone(
                      new Date(connection.lastPollAt),
                      locale,
                      house.timezone,
                      { dateStyle: "short", timeStyle: "short" },
                    )}</time>
                  : t("common.noData")}</dd></div>
              </dl>
              {connection.error && <p className="connection-source-error" role="alert"><TriangleAlert size={15} aria-hidden="true" /><span>{connection.error}</span></p>}
              <div className="connection-source-assignment">
                <span />
                <div className="connection-assignment-actions">
                  <button type="button" className="danger-button" disabled={busyId !== null} onClick={() => void disconnect(connection.id, name)}>
                    {busyId === connection.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                    {t("setup.disconnect")}
                  </button>
                </div>
              </div>
            </div>
          </details>;
        })}
      </div>}

      {addable.map((device) => <div className="guided-setup" key={device.mac}>
        <p className="configured-note">{device.transport === "ewpe-cloud" ? <Cloud size={17} aria-hidden="true" /> : <Snowflake size={17} aria-hidden="true" />}<span><strong>{t("setup.greeFound", { device: deviceName(device) })}</strong><br />{t(device.transport === "ewpe-cloud" ? "setup.greeCloudFoundHelp" : "setup.greeFoundHelp")}{device.cloudHomeName ? ` · ${device.cloudHomeName}${device.cloudRoomName ? ` / ${device.cloudRoomName}` : ""}` : ""}</span></p>
        <button type="button" className="primary-button full-width" disabled={busyId !== null} onClick={() => void add(device)}>
          {busyId === device.mac ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
          {t(busyId === device.mac ? "setup.greeAdding" : "setup.greeAdd", { home: house.name })}
        </button>
      </div>)}

      <details className="connection-source-card gree-cloud-setup">
        <summary className="connection-source-card-heading">
          <span className="connection-source-icon" aria-hidden="true"><Cloud size={20} /></span>
          <span className="connection-source-title"><small>{t("setup.greeCloudFallback")}</small><strong>{t("setup.greeCloudConnect")}</strong></span>
        </summary>
        <form className="connection-source-card-content integration-credential-form" onSubmit={(event) => void discoverCloud(event)}>
          <p className="field-help">{t("setup.greeCloudHelp")}</p>
          <label className="field"><span>{t("setup.greeCloudUsername")}</span><input autoComplete="username" required maxLength={320} value={cloudUsername} onChange={(event) => setCloudUsername(event.target.value)} /></label>
          <label className="field"><span>{t("setup.greeCloudPassword")}</span><input type="password" autoComplete="current-password" required maxLength={8192} value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} /></label>
          <button type="submit" className="secondary-button full-width" disabled={cloudPending || busyId !== null}>
            {cloudPending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Cloud size={16} aria-hidden="true" />}
            {t(cloudPending ? "setup.greeCloudChecking" : "setup.greeCloudDiscover")}
          </button>
        </form>
      </details>

      {feedback && <p className={`test-result ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"} aria-live="polite">
        {feedback.kind === "success" ? <Check size={17} aria-hidden="true" /> : <TriangleAlert size={17} aria-hidden="true" />}{feedback.text}
      </p>}
    </section>
  );
}
