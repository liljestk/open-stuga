import {
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyMember,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { MachineRequestProof } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    distribute(event: StugubySignedEvent, explicitGrant?: StugubyShareGrant): void;
    appendForMember(stugubyId: string, nodeId: string, event: StugubySignedEvent): void;
    publishMember(member: StugubyMember): void;
    sendMemberSnapshot(member: StugubyMember, targetNodeId: string): void;
    sendSharedPropertySnapshot(property: StugubySharedProperty, targetNodeId: string): void;
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
    authorizeDatasetEvent(event: StugubySignedEvent): StugubyShareGrant;
    verifyEvent(event: StugubySignedEvent, publicKey: string): void;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
    syncFederation(stugubyId: string, throwOnError: boolean, bypassCooldown?: boolean): Promise<void>;
    ensureNotificationStreams(): void;
  }

  interface StugubyServiceCore {
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
    syncNow(stugubyId: string): Promise<StugubySummary>;
    syncAll(): Promise<void>;
  }
}
