import { TpLinkCredentialTestResult, TpLinkHostChangeMessage, TpLinkSourceDiscoveryResult } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import "../core.js";

declare module "../core.js" {
  interface TpLinkConnectionBridgeInternals {
    stop(): void;
    restart(): void;
    discoverSources(
        timeoutMs?: number,
        preferredConnection?: { username: string; password: string },
      ): Promise<TpLinkSourceDiscoveryResult>;
    testCredentials(
        host: string,
        username: string,
        password: string,
        timeoutMs?: number,
      ): Promise<TpLinkCredentialTestResult>;
    spawnHelper(): void;
    handleLine(line: string): void;
    handleHostChange(message: TpLinkHostChangeMessage): void;
  }

  interface TpLinkConnectionBridgeCore {
    stop(): void;
    restart(): void;
    discoverSources(
        timeoutMs?: number,
        preferredConnection?: { username: string; password: string },
      ): Promise<TpLinkSourceDiscoveryResult>;
    testCredentials(
        host: string,
        username: string,
        password: string,
        timeoutMs?: number,
      ): Promise<TpLinkCredentialTestResult>;
  }
}
