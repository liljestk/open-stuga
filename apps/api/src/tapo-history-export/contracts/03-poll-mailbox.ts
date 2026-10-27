import "../core.js";

declare module "../core.js" {
  interface TapoHistoryExportServiceInternals {
    pollMailbox(): Promise<void>;
  }
}
