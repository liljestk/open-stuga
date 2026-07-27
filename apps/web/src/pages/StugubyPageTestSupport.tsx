import { render, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import axe from "axe-core";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StugubyShareGrant, StugubySummary } from "@climate-twin/stuguby-protocol";

import { api, type StugubyDetailResponse, type StugubyListResponse } from "../api";

import { I18nProvider } from "../i18n";

import { localDateTimeInput, StugubyPage } from "./StugubyPage";

export const identity: StugubyListResponse["identity"] = {
  nodeId: "node-local",
  displayName: "Local Stugu",
  publicKey: "public",
  keyFingerprint: "fingerprint",
  protocolVersion: "2.0",
};

export function summary(id: string, name: string): StugubySummary {
  return {
    id,
    name,
    description: null,
    coordinatorNodeId: "node-local",
    coordinatorUrl: "https://stugu.example.test",
    localRole: "steward",
    localMemberState: "active",
    memberCount: 1,
    createdAt: "2026-07-23T06:00:00.000Z",
    updatedAt: "2026-07-23T06:00:00.000Z",
    lastSyncAt: null,
    lastSyncError: null,
  };
}

export function detail(stuguby: StugubySummary, grants: StugubyShareGrant[] = []): StugubyDetailResponse {
  return {
    stuguby,
    members: [{
      stugubyId: stuguby.id,
      nodeId: "node-local",
      displayName: "Local Stugu",
      localLabel: null,
      role: "steward",
      state: "active",
      publicKey: "public",
      keyFingerprint: "fingerprint",
      joinedAt: "2026-07-23T06:00:00.000Z",
      updatedAt: "2026-07-23T06:00:00.000Z",
    }],
    invitations: [],
    grants,
    sharedProperty: {
      stugubyId: stuguby.id,
      name: `${stuguby.name} grounds`,
      description: null,
      location: null,
      areas: [],
      equipment: [],
      notes: [],
      maintenance: [],
      editPolicy: "collaborative",
      authorityEpoch: 1,
      designatedSuccessorNodeId: null,
      revision: 1,
      updatedAt: "2026-07-23T06:00:00.000Z",
    },
    propertyAdoption: null,
    propertyConflicts: [],
    propertyCommandCounts: { pending: 0, conflicts: 0 },
    homeCommandCounts: { pending: 0, conflicts: 0 },
    homeProjections: [],
    authorityTransfers: [],
    remoteResources: [],
    deletionReceipts: [],
    audit: [],
  };
}

export function localGrant(stugubyId: string, id: string, localHouseId: string): StugubyShareGrant {
  return {
    id,
    stugubyId,
    authorityNodeId: identity.nodeId,
    publicationId: `publication-${id}`,
    localHouseId,
    audience: { kind: "all-members", nodeIds: [] },
    housePolicy: {
      editPolicy: "read-only",
      recoveryMode: "none",
      designatedSuccessorNodeId: null,
    },
    datasets: [{
      dataset: "home.directory.v1",
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 30,
    }],
    epoch: 1,
    revision: 1,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-07-23T06:00:00.000Z",
    updatedAt: "2026-07-23T06:00:00.000Z",
  };
}

export function mockLoadedStugubys(stugubys: StugubySummary[], details: Record<string, StugubyDetailResponse | Promise<StugubyDetailResponse>>) {
  vi.spyOn(api, "stugubys").mockResolvedValue({ identity, publicOrigin: "https://stugu.example.test", stugubys });
  vi.spyOn(api, "stuguby").mockImplementation((id) => Promise.resolve(details[id]!));
  vi.spyOn(api, "syncStuguby").mockImplementation(async (id) => stugubys.find((candidate) => candidate.id === id)!);
  vi.spyOn(api, "stugubyTelemetry").mockResolvedValue({ samples: [] });
  vi.spyOn(api, "stugubyPublications").mockImplementation(async (_id, houseId) => ({
    house: { localHouseId: houseId, publicationId: `publication-${houseId}`, name: "Main Home" },
    sensors: [],
  }));
}
