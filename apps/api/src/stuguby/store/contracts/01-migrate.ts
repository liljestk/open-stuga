import "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    migrate(): void;
  }
}
