import {
  Home,
  LoaderCircle,
  Move,
  Network,
  Pencil,
  PlugZap,
  Router,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { House, IntegrationStatus, TpLinkConnectionStatus } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import type { Feedback } from "./setupModel";

type HomeAssistantConnection = NonNullable<IntegrationStatus["homeAssistant"]["connections"]>[number];
type TpLinkConnectionKind = "hub" | "energy-device" | "unknown";

interface ConnectionSourceManagerProps {
  connectionHouses: House[];
  homeAssistantAssignments: HomeAssistantConnection[];
  tpLinkAssignments: TpLinkConnectionStatus[];
  busyAssignment: string | null;
  assignmentHouseDrafts: Record<string, string>;
  assignmentFeedback: Feedback;
  onAssignmentHouseDraft: (key: string, houseId: string) => void;
  onMoveHomeAssistant: (fromHouseId: string, targetHouseId: string) => void;
  onDisconnectHomeAssistant: (houseId: string) => void;
  onMoveTpLink: (connectionId: string, fromHouseId: string, targetHouseId: string) => void;
  onDisconnectTpLink: (connectionId: string, houseId: string) => void;
  onEditTpLink: (connection: TpLinkConnectionStatus) => void;
  formatDateTime: (value: string | null | undefined) => string | null;
}

function tpLinkConnectionKind(connection: TpLinkConnectionStatus): TpLinkConnectionKind {
  if (connection.sourceType) return connection.sourceType;
  if (connection.hubModel) return "hub";
  if (connection.sourceModel && connection.connected) return "energy-device";
  return "unknown";
}

function ConnectionHealth({ connected, error }: Readonly<{ connected: boolean; error: string | null }>) {
  const { t } = useI18n();
  const state = error ? "error" : connected ? "connected" : "reconnecting";
  return (
    <span className={`connection-source-health ${state}`} role="status">
      <span aria-hidden="true" />
      {error ? t("setup.sourceNeedsAttention") : connected ? t("common.connected") : t("setup.sourceReconnecting")}
    </span>
  );
}

function SourceRoute({ icon: Icon, children }: Readonly<{ icon: LucideIcon; children: ReactNode }>) {
  return (
    <p className="connection-source-route">
      <Icon size={14} aria-hidden="true" />
      {children}
    </p>
  );
}

export function ConnectionSourceManager({
  connectionHouses,
  homeAssistantAssignments,
  tpLinkAssignments,
  busyAssignment,
  assignmentHouseDrafts,
  assignmentFeedback,
  onAssignmentHouseDraft,
  onMoveHomeAssistant,
  onDisconnectHomeAssistant,
  onMoveTpLink,
  onDisconnectTpLink,
  onEditTpLink,
  formatDateTime,
}: Readonly<ConnectionSourceManagerProps>) {
  const { t } = useI18n();
  const groupedTpLink = {
    hub: tpLinkAssignments.filter((connection) => tpLinkConnectionKind(connection) === "hub"),
    "energy-device": tpLinkAssignments.filter((connection) => tpLinkConnectionKind(connection) === "energy-device"),
    unknown: tpLinkAssignments.filter((connection) => tpLinkConnectionKind(connection) === "unknown"),
  };
  const assignmentCount = homeAssistantAssignments.length + tpLinkAssignments.length;
  const groups: Array<{
    kind: TpLinkConnectionKind;
    title: string;
    icon: LucideIcon;
    connections: TpLinkConnectionStatus[];
  }> = [
    {
      kind: "hub",
      title: t("setup.sourceGroupHubs"),
      icon: Router,
      connections: groupedTpLink.hub,
    },
    {
      kind: "energy-device",
      title: t("setup.sourceGroupDirectDevices"),
      icon: PlugZap,
      connections: groupedTpLink["energy-device"],
    },
    {
      kind: "unknown",
      title: t("setup.sourceGroupUnidentified"),
      icon: Network,
      connections: groupedTpLink.unknown,
    },
  ];

  return (
    <section className="panel connection-source-manager" aria-labelledby="connection-source-manager-title">
      <header className="connection-source-manager-header">
        <span className="ha-mark" aria-hidden="true"><Network size={22} /></span>
        <span>
          <span className="eyebrow">{t("setup.connectionManagerEyebrow")}</span>
          <h2 id="connection-source-manager-title">{t("setup.connectionManagerTitle")}</h2>
          <p>{t("setup.connectionManagerBody")}</p>
        </span>
        <span className="connection-source-count">{t("setup.connectionManagerCount", { count: assignmentCount })}</span>
      </header>

      {assignmentCount === 0
        ? <p className="connection-assignment-empty">{t("setup.noConnectionAssignments")}</p>
        : <div className="connection-source-groups">
          {groups.filter((group) => group.connections.length > 0).map((group) => {
            const GroupIcon = group.icon;
            return (
              <section className="connection-source-group" key={group.kind} aria-labelledby={`connection-source-${group.kind}`}>
                <header>
                  <span aria-hidden="true"><GroupIcon size={18} /></span>
                  <span>
                    <h3 id={`connection-source-${group.kind}`}>{group.title}</h3>
                  </span>
                </header>
                <div className="connection-source-list">
                  {group.connections.map((connection) => {
                    const assignedHouse = connectionHouses.find((candidate) => candidate.id === connection.houseId);
                    const key = `tp:${connection.id}`;
                    const targetHouseId = assignmentHouseDrafts[key] ?? connection.houseId;
                    const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                    const model = connection.sourceModel ?? connection.hubModel;
                    const kind = tpLinkConnectionKind(connection);
                    const fallbackName = kind === "hub"
                      ? t("setup.sourceHubName", { model: model ?? t("setup.tpLinkHub") })
                      : kind === "energy-device"
                        ? t("setup.sourceDirectName", { model: model ?? t("setup.tpLinkEnergyDevice") })
                        : t("setup.sourceUnknownName");
                    const sourceName = connection.sourceAlias ?? fallbackName;
                    const route = kind === "hub"
                      ? t("setup.sourceHubRoute", { model: model ?? t("setup.tpLinkHub") })
                      : kind === "energy-device"
                        ? t("setup.sourceDirectRoute", { model: model ?? t("setup.tpLinkEnergyDevice") })
                        : t("setup.sourceUnknownRoute");
                    return (
                      <details className={`connection-source-card ${kind} ${connection.error ? "attention" : ""}`} key={connection.id}>
                        <summary className="connection-source-card-heading">
                          <span className="connection-source-icon" aria-hidden="true">
                            {kind === "hub" ? <Router size={20} /> : kind === "energy-device" ? <PlugZap size={20} /> : <Network size={20} />}
                          </span>
                          <span className="connection-source-title">
                            <small>{t(kind === "hub" ? "setup.sourceKindHub" : kind === "energy-device" ? "setup.sourceKindDirect" : "setup.sourceKindUnknown")}</small>
                            <strong>{sourceName}</strong>
                            {connection.sourceAlias && model && <span>{model}</span>}
                          </span>
                          <ConnectionHealth connected={connection.connected} error={connection.error} />
                        </summary>
                        <div className="connection-source-card-content">
                          <SourceRoute icon={kind === "hub" ? Router : kind === "energy-device" ? PlugZap : Network}>
                            {route}
                          </SourceRoute>

                          <dl className="connection-source-facts">
                            <div><dt>{t("setup.sourceAddress")}</dt><dd><code>{connection.host ?? t("setup.sourceUnknownValue")}</code></dd></div>
                            <div><dt>{t("setup.sourceDevices")}</dt><dd>{kind === "hub"
                              ? t("setup.sourceDownstreamCount", { count: connection.discoveredDevices })
                              : t("setup.sourceDirectDevice")}</dd></div>
                            <div><dt>{t("setup.sourceMapped")}</dt><dd>{connection.mappedDevices}</dd></div>
                            <div><dt>{t("setup.sourceLastUpdate")}</dt><dd>{connection.lastPollAt
                              ? <time dateTime={connection.lastPollAt}>{formatDateTime(connection.lastPollAt) ?? connection.lastPollAt}</time>
                              : t("setup.tpLinkNoPoll")}</dd></div>
                          </dl>

                          {connection.error && <p className="connection-source-error" role="alert"><TriangleAlert size={15} aria-hidden="true" /><span>{connection.error}</span></p>}

                          <div className="connection-source-assignment">
                            <label className="connection-assignment-home">
                              <span>{t("setup.assignedHome")}</span>
                              <select
                                value={targetHouseId}
                                disabled={busyAssignment !== null}
                                aria-label={t("setup.assignedHomeFor", { source: sourceName })}
                                onChange={(event) => onAssignmentHouseDraft(key, event.target.value)}
                              >
                                {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                              </select>
                            </label>
                            <div className="connection-assignment-actions">
                              <button type="button" className="secondary-button" disabled={busyAssignment !== null} aria-label={t("setup.updateTpLinkLabel", { source: sourceName })} onClick={() => onEditTpLink(connection)}><Pencil size={14} aria-hidden="true" />{t("setup.updateAddress")}</button>
                              <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === connection.houseId} aria-label={t("setup.moveTpLinkLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => onMoveTpLink(connection.id, connection.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                              <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectTpLinkLabel", { home: assignedHouse?.name ?? connection.houseId })} onClick={() => onDisconnectTpLink(connection.id, connection.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                            </div>
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {homeAssistantAssignments.length > 0 && <section className="connection-source-group home-assistant" aria-labelledby="connection-source-home-assistant">
            <header>
              <span aria-hidden="true"><Home size={18} /></span>
              <span><h3 id="connection-source-home-assistant">Home Assistant</h3></span>
            </header>
            <div className="connection-source-list">
              {homeAssistantAssignments.map((connection) => {
                const assignedHouse = connectionHouses.find((candidate) => candidate.id === connection.houseId);
                const key = `ha:${connection.houseId}`;
                const targetHouseId = assignmentHouseDrafts[key] ?? connection.houseId;
                const targetHouse = connectionHouses.find((candidate) => candidate.id === targetHouseId);
                return (
                  <details className={`connection-source-card home-assistant ${connection.error ? "attention" : ""}`} key={key}>
                    <summary className="connection-source-card-heading">
                      <span className="connection-source-icon" aria-hidden="true"><Home size={20} /></span>
                      <span className="connection-source-title"><small>{t("setup.sourceKindHomeAssistant")}</small><strong>Home Assistant</strong></span>
                      <ConnectionHealth connected={connection.connected} error={connection.error} />
                    </summary>
                    <div className="connection-source-card-content">
                      <SourceRoute icon={Home}>{t("setup.sourceHomeAssistantRoute")}</SourceRoute>
                      <dl className="connection-source-facts">
                        <div><dt>{t("setup.sourceMappedEntities")}</dt><dd>{connection.mappedEntities}</dd></div>
                        <div><dt>{t("setup.sourceLastUpdate")}</dt><dd>{connection.lastEventAt
                          ? <time dateTime={connection.lastEventAt}>{formatDateTime(connection.lastEventAt) ?? connection.lastEventAt}</time>
                          : t("common.noData")}</dd></div>
                      </dl>
                      {connection.error && <p className="connection-source-error" role="alert"><TriangleAlert size={15} aria-hidden="true" /><span>{connection.error}</span></p>}
                      <div className="connection-source-assignment">
                        <label className="connection-assignment-home">
                          <span>{t("setup.assignedHome")}</span>
                          <select
                            value={targetHouseId}
                            disabled={busyAssignment !== null}
                            aria-label={t("setup.assignedHomeFor", { source: "Home Assistant" })}
                            onChange={(event) => onAssignmentHouseDraft(key, event.target.value)}
                          >
                            {connectionHouses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={candidate.id !== connection.houseId && homeAssistantAssignments.some((current) => current.houseId === candidate.id)}>{candidate.name}</option>)}
                          </select>
                        </label>
                        <div className="connection-assignment-actions">
                          <button type="button" className="secondary-button" disabled={busyAssignment !== null || targetHouseId === connection.houseId} aria-label={t("setup.moveHomeAssistantLabel", { home: targetHouse?.name ?? targetHouseId })} onClick={() => onMoveHomeAssistant(connection.houseId, targetHouseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Move size={14} aria-hidden="true" />}{t("setup.move")}</button>
                          <button type="button" className="danger-button" disabled={busyAssignment !== null} aria-label={t("setup.disconnectHomeAssistantLabel", { home: assignedHouse?.name ?? connection.houseId })} onClick={() => onDisconnectHomeAssistant(connection.houseId)}>{busyAssignment === key ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}{t("setup.disconnect")}</button>
                        </div>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>}
        </div>}

      {assignmentFeedback && <p className={`test-result ${assignmentFeedback.kind}`} role={assignmentFeedback.kind === "error" ? "alert" : "status"}>{assignmentFeedback.message}</p>}
    </section>
  );
}
