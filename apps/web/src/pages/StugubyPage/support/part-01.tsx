import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { House, Property } from "@climate-twin/contracts";
import {
  STUGBY_DATASETS,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyMember,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { AlertTriangle, Check, Copy, Database, KeyRound, Link, LoaderCircle, Network, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Unplug, Users } from "lucide-react";
import {
  api,
  type StugubyDetailResponse,
  type StugubyInvitationCreated,
  type StugubyListResponse,
  type StugubyLocalMember,
  type StugubyLocalPublicationCatalog,
  type StugubyRemoteTelemetrySample,
} from "../../../api";
import { StugubyMark } from "../../../components/StugubyMark";
import { formatInTimeZone } from "../../../dateTime";
import { useI18n, type TranslationKey } from "../../../i18n";
import { CloudflareSetupPanel } from "../../CloudflareSetupPanel";
import "../../StugubyPage.css";

export interface StugubyPageProps {
  houses: Array<Pick<House, "id" | "name" | "propertyId" | "stuguby">>;
  properties?: Array<Pick<Property, "id" | "name" | "stuguby">>;
  onInventoryChange?: () => void;
}

export interface DatasetDraft {
  enabled: boolean;
  includeLocalIds: boolean;
  allowReplicaCache: boolean;
  retentionDays: number;
}

export type PublicationCatalogState =
  | { status: "idle"; stugubyId: null; houseId: null; data: null; error: null }
  | { status: "loading"; stugubyId: string; houseId: string; data: null; error: null }
  | { status: "ready"; stugubyId: string; houseId: string; data: StugubyLocalPublicationCatalog; error: null }
  | { status: "error"; stugubyId: string; houseId: string; data: null; error: string };

export const idlePublicationCatalog = (): PublicationCatalogState => ({
  status: "idle",
  stugubyId: null,
  houseId: null,
  data: null,
  error: null,
});

export const datasetLabelKeys: Record<StugubyDataset, TranslationKey> = {
  "home.directory.v1": "stuguby.dataset.directory",
  "home.location.v1": "stuguby.dataset.location",
  "home.structure.v1": "stuguby.dataset.structure",
  "home.floorplan.v1": "stuguby.dataset.floorplan",
  "home.sensor-catalog.v1": "stuguby.dataset.sensors",
  "home.telemetry.v1": "stuguby.dataset.telemetry",
  "home.notes.v1": "stuguby.dataset.notes",
  "home.observations.v1": "stuguby.dataset.observations",
  "home.recovery.v1": "stuguby.dataset.recovery",
};

export const editableHomeDatasets = new Set<StugubyDataset>([
  "home.directory.v1",
  "home.location.v1",
  "home.structure.v1",
  "home.sensor-catalog.v1",
  "home.notes.v1",
  "home.observations.v1",
]);

export const roleLabelKeys: Record<StugubyRole, TranslationKey> = {
  steward: "stuguby.role.steward",
  "property-manager": "stuguby.role.propertyManager",
  participant: "stuguby.role.participant",
  viewer: "stuguby.role.viewer",
};

export const memberStateLabelKeys: Record<StugubyMember["state"], TranslationKey> = {
  invited: "stuguby.state.invited",
  active: "stuguby.state.active",
  suspended: "stuguby.state.suspended",
  left: "stuguby.state.left",
  revoked: "stuguby.state.revoked",
};

export function initialDatasetDraft(): Record<StugubyDataset, DatasetDraft> {
  return Object.fromEntries(STUGBY_DATASETS.map((dataset) => [dataset, {
    enabled: ["home.directory.v1", "home.structure.v1", "home.sensor-catalog.v1"].includes(dataset),
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: dataset === "home.telemetry.v1" ? 7 : 30,
  }])) as Record<StugubyDataset, DatasetDraft>;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function formattedTime(value: string | null, never: string, locale: string): string {
  if (!value) return never;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? formatInTimeZone(date, locale, undefined, {
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit",
      })
    : value;
}

export function suggestedCoordinatorOrigin(): string {
  try {
    const url = new URL(window.location.origin);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : "";
  } catch {
    return "";
  }
}

export function loopbackOrigin(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function localDateTimeInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function parseArray(value: string, label: string, invalidJson: string, notArray: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(invalidJson.replace("{label}", label)); }
  if (!Array.isArray(parsed)) throw new Error(notArray.replace("{label}", label));
  return parsed;
}

export function grantHomeName(
  grant: StugubyShareGrant,
  houses: StugubyPageProps["houses"],
  remoteResources: StugubyDetailResponse["remoteResources"],
  localNodeId: string,
): string | null {
  const localHouse = grant.authorityNodeId === localNodeId && grant.localHouseId
    ? houses.find((house) => house.id === grant.localHouseId)
    : null;
  if (localHouse?.name.trim()) return localHouse.name;

  const projectedHouse = houses.find((house) => (
    house.stuguby?.stugubyId === grant.stugubyId
    && house.stuguby.authorityNodeId === grant.authorityNodeId
    && house.stuguby.publicationId === grant.publicationId
  ));
  if (projectedHouse?.name.trim()) return projectedHouse.name;

  const directory = remoteResources.find((resource) => (
    resource.authorityNodeId === grant.authorityNodeId
    && resource.publicationId === grant.publicationId
    && resource.schema === "home.directory.v1"
  ));
  const name = directory?.payload && !Array.isArray(directory.payload) && typeof directory.payload === "object"
    ? directory.payload.name
    : null;
  return typeof name === "string" && name.trim() ? name : null;
}

export function MemberIdentity({
  member,
  isLocal,
  disabled,
  youLabel,
  privateLabel,
  privateLabelPlaceholder,
  metadata,
  onSave,
}: Readonly<{
  member: StugubyLocalMember;
  isLocal: boolean;
  disabled: boolean;
  youLabel: string;
  privateLabel: string;
  privateLabelPlaceholder: string;
  metadata: string;
  onSave: (value: string | null) => void;
}>) {
  const storedLabel = member.localLabel ?? "";
  const [draft, setDraft] = useState(storedLabel);
  useEffect(() => setDraft(storedLabel), [storedLabel]);
  const save = () => {
    const normalized = draft.trim();
    if (normalized !== storedLabel) onSave(normalized || null);
  };
  return <div className="stuguby-member-identity">
    {isLocal ? <strong>{youLabel}</strong> : <label className="stuguby-member-local-label">
      <span>{privateLabel}</span>
      <input
        value={draft}
        maxLength={200}
        placeholder={privateLabelPlaceholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(storedLabel);
            event.currentTarget.blur();
          }
        }}
      />
    </label>}
    <small>{metadata}</small>
  </div>;
}

export function activeGrant(grant: StugubyShareGrant, now = Date.now()): boolean {
  if (grant.revokedAt) return false;
  if (!grant.expiresAt) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
}
