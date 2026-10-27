import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    removeRemoteHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): void;
    materializeRemoteHome(stugubyId: string, authorityNodeId: string, publicationId: string): void;
  }
}
