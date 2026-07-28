import type { StugubyShareGrant } from "@climate-twin/stuguby-protocol";
import { AlertTriangle, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { StugubyDetailResponse } from "../../api";
import { useI18n } from "../../i18n";
import { activeGrant, datasetLabelKeys, grantHomeName, type StugubyPageProps } from "./support";

interface GrantOverviewProps {
  detail: StugubyDetailResponse;
  houses: StugubyPageProps["houses"];
  localNodeId: string;
  busy: boolean;
  onEdit: (grant: StugubyShareGrant) => void;
  onRepublish: (grant: StugubyShareGrant) => void;
  onRevoke: (grant: StugubyShareGrant) => void;
  onRemoveInvalid: (grant: StugubyShareGrant) => void;
}

interface GrantCardProps extends GrantOverviewProps {
  grant: StugubyShareGrant;
  duplicate?: boolean;
  invalid?: boolean;
}

function GrantCard({
  detail,
  houses,
  localNodeId,
  busy,
  grant,
  duplicate = false,
  invalid = false,
  onEdit,
  onRepublish,
  onRevoke,
  onRemoveInvalid,
}: GrantCardProps) {
  const { t } = useI18n();
  const isActive = activeGrant(grant);
  const authority = detail.members.find((member) => member.nodeId === grant.authorityNodeId);
  const suspectedLocalHome = invalid && grant.localHouseId
    ? houses.find((house) => house.id === grant.localHouseId)
    : null;
  const homeName = grantHomeName(grant, houses, detail.remoteResources, localNodeId)
    ?? suspectedLocalHome?.name
    ?? t("stuguby.unknownSharedHome");
  const stateKey = grant.revokedAt
    ? "stuguby.state.revoked"
    : isActive ? "stuguby.state.active" : "stuguby.state.expired";
  const audienceKey = grant.audience.kind === "all-members"
    ? "stuguby.grantAudienceAll"
    : grant.audience.nodeIds.length === 1
      ? "stuguby.grantAudienceSelectedOne"
      : "stuguby.grantAudienceSelectedMany";
  const enabledDatasets = grant.datasets.filter((dataset) => dataset.enabled);
  const localAuthority = grant.authorityNodeId === localNodeId;

  return <article className={`${duplicate ? "has-duplicate" : ""} ${invalid ? "has-issue" : ""}`.trim()}>
    <div className="stuguby-record-copy">
      <div className="stuguby-grant-title">
        <strong>{homeName}</strong>
        <span className={`stuguby-status-badge ${isActive ? "active" : ""}`}>{t(stateKey)}</span>
      </div>
      {duplicate && <small className="stuguby-duplicate-label">{t("stuguby.duplicateActiveShare")}</small>}
      {invalid
        ? <span className="stuguby-invalid-label">{t("stuguby.invalidShareRecord")}</span>
        : <span>{localAuthority
          ? t("stuguby.sharedByThisStugu")
          : t("stuguby.sharedByMember", { member: authority?.localLabel || authority?.displayName || t("stuguby.unknownMember") })
        }</span>}
      <small>{t(audienceKey, { count: grant.audience.nodeIds.length })}</small>
      <small>{t(grant.housePolicy.editPolicy === "read-only" ? "stuguby.sharedHomeReadOnly" : "stuguby.sharedHomeEditable")}{grant.housePolicy.recoveryMode === "full" ? ` · ${t("stuguby.fullRecoveryEnabled")}` : ""}</small>
      <details className="stuguby-grant-data">
        <summary>{t("stuguby.viewSharedData", { count: enabledDatasets.length })}</summary>
        <ul>{enabledDatasets.map((dataset) => <li key={dataset.dataset}>{t(datasetLabelKeys[dataset.dataset])}</li>)}</ul>
        <small>{t("stuguby.grantVersion", { epoch: grant.epoch })}</small>
      </details>
    </div>
    {localAuthority && isActive && !invalid && <div className="stuguby-record-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onEdit(grant)}><Pencil size={15} aria-hidden="true" />{t("stuguby.editGrant")}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onRepublish(grant)}><RefreshCw size={15} aria-hidden="true" />{t("stuguby.republish")}</button>
      <button type="button" className="danger-button" disabled={busy} onClick={() => onRevoke(grant)}><Trash2 size={15} aria-hidden="true" />{t("stuguby.revoke")}</button>
    </div>}
    {invalid && !localAuthority && <div className="stuguby-record-actions">
      <button type="button" className="danger-button" disabled={busy} onClick={() => onRemoveInvalid(grant)}>
        <Trash2 size={15} aria-hidden="true" />{t("stuguby.removeInvalidShare")}
      </button>
    </div>}
  </article>;
}

export function GrantOverview(props: GrantOverviewProps) {
  const { t } = useI18n();
  const { detail, localNodeId } = props;
  const activeMembers = new Set(detail.members.filter((member) => member.state === "active").map((member) => member.nodeId));
  const active = detail.grants.filter((grant) => activeGrant(grant));
  const invalid = active.filter((grant) => !activeMembers.has(grant.authorityNodeId));
  const invalidIds = new Set(invalid.map((grant) => grant.id));
  const local = active.filter((grant) => grant.authorityNodeId === localNodeId && !invalidIds.has(grant.id));
  const remote = active.filter((grant) => grant.authorityNodeId !== localNodeId && !invalidIds.has(grant.id));
  const history = detail.grants.filter((grant) => !activeGrant(grant));
  const activeGrantCounts = new Map<string, number>();
  for (const grant of local) {
    if (grant.localHouseId) activeGrantCounts.set(grant.localHouseId, (activeGrantCounts.get(grant.localHouseId) ?? 0) + 1);
  }
  const duplicatedLocalHouseIds = new Set(
    [...activeGrantCounts].filter(([, count]) => count > 1).map(([houseId]) => houseId),
  );
  const duplicatedHomeNames = props.houses
    .filter((house) => duplicatedLocalHouseIds.has(house.id))
    .map((house) => house.name);
  const card = (grant: StugubyShareGrant, cardProps: { duplicate?: boolean; invalid?: boolean } = {}) =>
    <GrantCard key={grant.id} {...props} grant={grant} {...cardProps} />;

  if (detail.grants.length === 0) return <p>{t("stuguby.noGrants")}</p>;

  return <div className="stuguby-grant-groups">
    {(invalid.length > 0 || duplicatedHomeNames.length > 0) && <section className="stuguby-grant-attention" aria-labelledby="stuguby-grant-attention-title">
      <div className="stuguby-grant-group-header">
        <AlertTriangle size={19} aria-hidden="true" />
        <div><h3 id="stuguby-grant-attention-title">{t("stuguby.needsAttention")}</h3><p>{t("stuguby.needsAttentionBody")}</p></div>
      </div>
      {duplicatedHomeNames.length > 0 && <p className="stuguby-duplicate-warning" role="note">{t("stuguby.duplicateHomeShares", { homes: duplicatedHomeNames.join(", ") })}</p>}
      {invalid.length > 0 && <p className="stuguby-invalid-warning">{t("stuguby.invalidShareHelp")}</p>}
      <div className="stuguby-existing-grants">{invalid.map((grant) => card(grant, { invalid: true }))}</div>
    </section>}

    <section className="stuguby-grant-group" aria-labelledby="stuguby-outgoing-shares-title">
      <div className="stuguby-grant-group-header"><div><h3 id="stuguby-outgoing-shares-title">{t("stuguby.outgoingSharesTitle")}</h3><p>{t("stuguby.outgoingSharesBody")}</p></div><span>{local.length}</span></div>
      {local.length === 0 ? <p className="stuguby-empty-grants">{t("stuguby.noOutgoingShares")}</p> : <div className="stuguby-existing-grants">
        {local.map((grant) => card(grant, { duplicate: Boolean(grant.localHouseId && duplicatedLocalHouseIds.has(grant.localHouseId)) }))}
      </div>}
    </section>

    <section className="stuguby-grant-group" aria-labelledby="stuguby-incoming-shares-title">
      <div className="stuguby-grant-group-header"><div><h3 id="stuguby-incoming-shares-title">{t("stuguby.incomingSharesTitle")}</h3><p>{t("stuguby.incomingSharesBody")}</p></div><span>{remote.length}</span></div>
      {remote.length === 0 ? <p className="stuguby-empty-grants">{t("stuguby.noIncomingShares")}</p> : <div className="stuguby-existing-grants">{remote.map((grant) => card(grant))}</div>}
    </section>

    {history.length > 0 && <details className="stuguby-grant-history">
      <summary>{t("stuguby.sharingHistory", { count: history.length })}</summary>
      <p>{t("stuguby.sharingHistoryBody")}</p>
      <div className="stuguby-existing-grants">{history.map((grant) => card(grant))}</div>
    </details>}
  </div>;
}
