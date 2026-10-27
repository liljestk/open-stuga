/** This installation's view of its Stuguby memberships: projected Homes, adopted Properties and authority transfers. None of it is sent to peers. */

export interface StugubyPropertyAdoption {
  stugubyId: string;
  localPropertyId: string;
  state: "adopted" | "detached";
  adoptedAt: string;
  detachedAt: string | null;
  lastMaterializedRevision: number;
}

export interface StugubyHomeProjection {
  stugubyId: string;
  authorityNodeId: string;
  publicationId: string;
  localHouseId: string;
  editPolicy: "read-only" | "editable";
  recoveryMode: "none" | "full";
  recoveryState: "not-enabled" | "syncing" | "ready" | "incomplete";
  designatedSuccessorNodeId: string | null;
  recoverySyncedThrough: string | null;
  authorityEpoch: number;
  detachedAt: string | null;
  updatedAt: string;
}

export interface StugubyAuthorityTransfer {
  id: string;
  stugubyId: string;
  scope: "property" | "home";
  resourceId: string;
  fromNodeId: string;
  toNodeId: string;
  fromEpoch: number;
  toEpoch: number;
  status: "prepared" | "completed" | "cancelled";
  snapshotHash: string;
  requestedAt: string;
  completedAt: string | null;
}
