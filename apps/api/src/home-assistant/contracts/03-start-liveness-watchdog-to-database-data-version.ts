import "../core.js";

declare module "../core.js" {
  interface HomeAssistantConnectionBridgeInternals {
    startLivenessWatchdog(): void;
    databaseDataVersion(): number;
  }
}
