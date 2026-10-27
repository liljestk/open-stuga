import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    migrateCoreAndResourceSchema(): void;
  }
}
