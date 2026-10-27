import {
  type StugubyDeletionReceipt,
  type StugubySignedEvent,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import {
  type StugubyOutboxItem,
} from "../../store.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    notificationLoop(stugubyId: string, controller: AbortController): Promise<void>;
    syncOne(stugubyId: string, throwOnError: boolean): Promise<void>;
    expireLocalGrants(stugubyId: string): void;
    flushOutbox(stuguby: StugubySummary): Promise<void>;
    flushHomeCommands(stuguby: StugubySummary): Promise<void>;
    flushPropertyCommands(stuguby: StugubySummary): Promise<void>;
    uploadReferencedBlobs(stuguby: StugubySummary, item: StugubyOutboxItem): Promise<void>;
    applyPulledEvent(stuguby: StugubySummary, event: StugubySignedEvent): Promise<void>;
    sendDeletionReceipt(stuguby: StugubySummary, receipt: StugubyDeletionReceipt): Promise<void>;
  }
}
