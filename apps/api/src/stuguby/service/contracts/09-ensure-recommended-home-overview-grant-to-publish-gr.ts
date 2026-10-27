import type {
  House,
} from "@climate-twin/contracts";
import {
  type StugubyDatasetGrant,
  type StugubyGrantAudience,
  type StugubyShareGrant,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    ensureRecommendedHomeOverviewGrant(stugubyId: string, localHouseId: string): StugubyShareGrant | null;
    backfillRecommendedHomeOverviews(stugubyId: string): void;
    createGrant(stugubyId: string, input: {
            localHouseId: string;
            audience: StugubyGrantAudience;
            datasets: StugubyDatasetGrant[];
            housePolicy?: StugubyShareGrant["housePolicy"];
            expiresAt?: string | null;
        }): StugubyShareGrant;
    localPublicationCatalog(stugubyId: string, localHouseId: string): {
            house: {
                localHouseId: string;
                publicationId: string;
                name: string;
            };
            sensors: Array<{
                localSensorId: string;
                sensorPublicationId: string;
                name: string;
                metricIds: string[];
            }>;
        };
    updateGrant(grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant;
    revokeGrant(grantId: string): StugubyShareGrant;
    retireLocalHouseShares(houseId: string): {
            revokedGrantIds: string[];
            cancelledHomeCommands: number;
        };
    removeInvalidGrant(grantId: string): { removed: true; grantId: string };
    republishGrant(grantId: string): void;
    validateGrantAgainstMembership(grant: StugubyShareGrant, authorityNodeId?: unknown ): void;
    validateEditableHomeGrant(grant: StugubyShareGrant): void;
    validateUniqueRecoverySuccessor(grant: StugubyShareGrant): void;
    validateUniqueActiveHomeGrant(grant: StugubyShareGrant): void;
    markLocalHouseInAdoptedProperty(houseId: string): House;
    markLocalSharedHouse(grant: StugubyShareGrant, house: House): void;
    refreshLocalSharedHouseLink(stugubyId: string, houseId: string): void;
    publishGrant(grant: StugubyShareGrant, eventKind: "grant.upserted" | "grant.revoked"): void;
  }

  interface StugubyServiceCore {
    createGrant(stugubyId: string, input: {
            localHouseId: string;
            audience: StugubyGrantAudience;
            datasets: StugubyDatasetGrant[];
            housePolicy?: StugubyShareGrant["housePolicy"];
            expiresAt?: string | null;
        }): StugubyShareGrant;
    localPublicationCatalog(stugubyId: string, localHouseId: string): {
            house: {
                localHouseId: string;
                publicationId: string;
                name: string;
            };
            sensors: Array<{
                localSensorId: string;
                sensorPublicationId: string;
                name: string;
                metricIds: string[];
            }>;
        };
    updateGrant(grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant;
    revokeGrant(grantId: string): StugubyShareGrant;
    retireLocalHouseShares(houseId: string): {
            revokedGrantIds: string[];
            cancelledHomeCommands: number;
        };
    removeInvalidGrant(grantId: string): { removed: true; grantId: string };
    republishGrant(grantId: string): void;
    markLocalHouseInAdoptedProperty(houseId: string): House;
  }
}
